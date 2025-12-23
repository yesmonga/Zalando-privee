const express = require('express');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Configuration - All sensitive data from environment variables
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkoutUrl: "https://www.zalando-prive.fr/cart",
  cartReservationMinutes: 20,
  checkIntervalMs: 60 * 1000,
  authorization: process.env.ZALANDO_TOKEN || "",
  refreshToken: process.env.ZALANDO_REFRESH_TOKEN || "",
  salesChannel: "a332da49-a665-4a13-bd44-1ecea09b4d86",
  appDomainId: "18",
  tokenExpiresAt: null,
  tokenRefreshIntervalMs: 50 * 60 * 1000 // Refresh every 50 minutes (token expires in 60 min)
};

// Token refresh interval reference
let tokenRefreshInterval = null;

// Store monitored products
const monitoredProducts = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// ============== ZALANDO API FUNCTIONS ==============

function makeRequest(method, path, body = null, isCartRequest = false) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;

    const headers = {
      'User-Agent': 'Client/ios-app AppVersion/614 AppVersionName/4.72.0 AppDomain/18 OS/26.2',
      'X-Device-Type': 'smartphone',
      'X-Zalando-Client-Id': '53BEFF53-D469-4DDA-913E-33F4555D2CEE',
      'X-Device-OS': 'iOS',
      'X-Flow-Id': `I${Date.now().toString(16).toUpperCase()}-${Math.random().toString(16).slice(2, 6)}`,
      'X-Sales-Channel': CONFIG.salesChannel,
      'X-App-Version': '4.72.0',
      'Authorization': CONFIG.authorization,
      'zmobile-os': 'ios',
      'Accept-Language': 'fr-FR',
      'X-APPDOMAINID': CONFIG.appDomainId,
      'CLIENT_TYPE': 'ios-app',
      'Accept': 'application/json,application/problem+json',
      'Content-Type': 'application/json',
      'X-IOS-VERSION': '4.72.0',
      'X-API-VERSION': 'v1',
      'Connection': 'keep-alive'
    };

    // Add cart-specific headers
    if (isCartRequest) {
      headers['x-enable-unreserved-cart'] = 'true';
    }

    const options = {
      hostname: 'api.zalando-lounge.com',
      port: 443,
      path: path,
      method: method,
      headers: headers
    };

    if (postData) {
      options.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Check for HTTP-level auth errors
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Unauthorized (${res.statusCode}) - Token expired or invalid`));
          return;
        }
        
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
          return;
        }
        
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function fetchProductDetails(campaignId, articleId) {
  const path = `/phoenix-api/catalog/events/${campaignId}/articles/${articleId}`;
  const response = await makeRequest('GET', path);
  
  if (!response || !response.sku) {
    throw new Error('Product not found');
  }

  const productInfo = {
    title: response.nameShop || response.nameCategoryTag,
    brand: response.brand,
    color: response.nameColor,
    price: `€${(response.specialPrice / 100).toFixed(2)}`,
    originalPrice: `€${(response.price / 100).toFixed(2)}`,
    discount: `-${response.savings}%`,
    configSku: response.sku,
    campaignId: campaignId,
    image: response.images?.[0] || null
  };

  // Extract sizes from simples array
  const sizeMapping = {};
  const simpleSkus = [];
  
  if (response.simples && Array.isArray(response.simples)) {
    response.simples.forEach(simple => {
      const size = simple.supplier_size || simple.filterValue || 'N/A';
      sizeMapping[simple.sku] = {
        size: size,
        stockStatus: simple.stockStatus,
        inStock: simple.stockStatus === 'AVAILABLE'
      };
      simpleSkus.push(simple.sku);
    });
  }

  return { productInfo, sizeMapping, simpleSkus };
}

async function checkStock(configSku, simpleSkus, campaignId) {
  const path = '/stockcart/articles';
  const body = {
    configSku: configSku,
    simpleSkus: simpleSkus,
    campaignIdentifier: campaignId
  };

  const response = await makeRequest('POST', path, body);
  
  if (!Array.isArray(response)) {
    throw new Error('Invalid stock response');
  }

  const stockInfo = {};
  response.forEach(item => {
    stockInfo[item.simpleSku] = {
      quantity: item.quantity || 0,
      stockStatus: item.stockStatus,
      inStock: item.stockStatus === 'AVAILABLE' && item.quantity > 0
    };
  });

  return stockInfo;
}

async function addToCart(configSku, simpleSku, campaignId) {
  const path = '/stockcart/cart/items';
  const body = {
    configSku: configSku,
    quantity: "1",
    campaignIdentifier: campaignId,
    simpleSku: simpleSku
  };

  const response = await makeRequest('POST', path, body, true); // isCartRequest = true
  
  // Check if item was added successfully
  if (response && response.items && response.items.length > 0) {
    return {
      success: true,
      remainingSeconds: response.remainingLifetimeSeconds || 1200
    };
  }
  
  return { success: false };
}

// ============== DISCORD NOTIFICATIONS ==============

function sendDiscordWebhook(payload) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.discordWebhook) {
      console.log('Discord webhook not configured');
      return resolve(false);
    }
    
    const webhookUrl = new URL(CONFIG.discordWebhook);
    const payloadStr = JSON.stringify(payload);

    const options = {
      hostname: webhookUrl.hostname,
      port: 443,
      path: webhookUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 204 || res.statusCode === 200) {
        resolve(true);
      } else {
        reject(new Error(`Discord error: ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });
}

function sendDiscordNotification(productInfo, simpleSku, size, quantity, productUrl) {
  const checkoutUrl = 'https://www.zalando-prive.fr/checkout';
  
  const embed = {
    title: "🚨 STOCK DISPONIBLE!",
    color: 0xff6900, // Zalando orange
    fields: [
      { name: "👕 Produit", value: `**${productInfo.brand} - ${productInfo.title}**`, inline: false },
      { name: "🎨 Couleur", value: productInfo.color || '-', inline: true },
      { name: "📏 Taille", value: `**${size}**`, inline: true },
      { name: "📦 Quantité", value: `${quantity} dispo`, inline: true },
      { name: "💰 Prix", value: `${productInfo.price} (${productInfo.discount})`, inline: false },
      { name: "🔗 Lien produit", value: `[Voir le produit](${productUrl})`, inline: true },
      { name: "🛒 Checkout", value: `[Aller au panier](${checkoutUrl})`, inline: true }
    ],
    footer: { text: `SKU: ${simpleSku}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🚨 **NOUVEAU STOCK - AJOUTE VITE AU PANIER!**",
    embeds: [embed]
  });
}

let tokenExpiredNotificationSent = false;

function sendTokenExpiredNotification(errorMessage) {
  if (tokenExpiredNotificationSent) {
    return Promise.resolve(false);
  }
  
  tokenExpiredNotificationSent = true;
  
  const embed = {
    title: "⚠️ TOKEN EXPIRÉ",
    color: 0xf87171,
    description: "Le token Zalando Privé a expiré. Le monitoring est en pause jusqu'à la mise à jour du token.",
    fields: [
      { name: "🔧 Action requise", value: "Mettez à jour le token via l'interface web ou la variable d'environnement Railway", inline: false },
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false }
    ],
    footer: { text: "Zalando Privé Monitor" },
    timestamp: new Date().toISOString()
  };

  console.log('⚠️ Token expired - sending Discord notification');
  
  return sendDiscordWebhook({
    content: "@everyone ⚠️ **TOKEN EXPIRÉ - MISE À JOUR REQUISE!**",
    embeds: [embed]
  });
}

function resetTokenExpiredFlag() {
  tokenExpiredNotificationSent = false;
}

// ============== UTILITY FUNCTIONS ==============

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

// ============== TOKEN REFRESH LOGIC ==============

function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    if (!CONFIG.refreshToken) {
      reject(new Error('No refresh token configured'));
      return;
    }

    const postData = `refresh_token=${encodeURIComponent(CONFIG.refreshToken)}&client_id=lounge&grant_type=refresh_token`;

    const options = {
      hostname: 'customer-iam.zalandoapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Prive/614 CFNetwork/3860.300.31 Darwin/25.2.0',
        'Accept': '*/*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (response.access_token && response.refresh_token) {
            resolve(response);
          } else {
            reject(new Error(`Token refresh failed: ${data}`));
          }
        } catch (error) {
          reject(new Error(`Parse error: ${error.message} - Response: ${data}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.write(postData);
    req.end();
  });
}

function sendTokenRefreshedNotification() {
  const embed = {
    title: "✅ TOKEN RAFRAÎCHI",
    color: 0x22c55e, // Green
    description: "Le token Zalando Privé a été automatiquement rafraîchi.",
    fields: [
      { name: "⏰ Prochain refresh", value: "Dans ~50 minutes", inline: true },
      { name: "📊 Statut", value: "Monitoring actif", inline: true }
    ],
    footer: { text: "Zalando Privé Monitor - Auto Refresh" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "✅ **Token rafraîchi automatiquement**",
    embeds: [embed]
  });
}

function sendTokenRefreshFailedNotification(errorMessage) {
  const embed = {
    title: "❌ ÉCHEC DU REFRESH TOKEN",
    color: 0xf87171, // Red
    description: "Impossible de rafraîchir le token automatiquement. Mise à jour manuelle requise.",
    fields: [
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false },
      { name: "🔧 Action requise", value: "Mettez à jour le refresh_token via Railway ou l'interface web", inline: false }
    ],
    footer: { text: "Zalando Privé Monitor" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone ❌ **ÉCHEC REFRESH TOKEN - MISE À JOUR MANUELLE REQUISE!**",
    embeds: [embed]
  });
}

async function performTokenRefresh() {
  console.log(`[${getTimestamp()}] 🔄 Attempting to refresh access token...`);
  
  try {
    const tokenResponse = await refreshAccessToken();
    
    // Update tokens in CONFIG
    CONFIG.authorization = `Bearer ${tokenResponse.access_token}`;
    CONFIG.refreshToken = tokenResponse.refresh_token;
    CONFIG.tokenExpiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    
    // Reset the expired notification flag since we have a new valid token
    resetTokenExpiredFlag();
    
    console.log(`[${getTimestamp()}] ✅ Token refreshed successfully! Expires in ${tokenResponse.expires_in}s`);
    
    // Send Discord notification
    await sendTokenRefreshedNotification();
    
    return true;
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Token refresh failed:`, error.message);
    
    // Send Discord notification about failure
    await sendTokenRefreshFailedNotification(error.message);
    
    return false;
  }
}

function startTokenRefresh() {
  if (tokenRefreshInterval) {
    console.log(`[${getTimestamp()}] Token refresh already running`);
    return;
  }
  
  if (!CONFIG.refreshToken) {
    console.log(`[${getTimestamp()}] ⚠️ No refresh token configured - automatic refresh disabled`);
    return;
  }
  
  // Perform initial refresh
  performTokenRefresh();
  
  // Set up interval for automatic refresh (every 50 minutes)
  tokenRefreshInterval = setInterval(performTokenRefresh, CONFIG.tokenRefreshIntervalMs);
  console.log(`[${getTimestamp()}] 🔄 Token auto-refresh started (every 50 min)`);
}

function stopTokenRefresh() {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
    console.log(`[${getTimestamp()}] Token auto-refresh stopped`);
  }
}

// ============== MONITORING LOGIC ==============

async function monitorAllProducts() {
  for (const [key, product] of monitoredProducts) {
    try {
      const currentStock = await checkStock(
        product.productInfo.configSku,
        product.simpleSkus,
        product.productInfo.campaignId
      );
      
      console.log(`[${getTimestamp()}] Checking ${product.productInfo.brand} - ${product.productInfo.title}`);
      
      for (const [simpleSku, stockData] of Object.entries(currentStock)) {
        const prevStock = product.previousStock[simpleSku];
        const wasOutOfStock = !prevStock || !prevStock.inStock;
        const nowInStock = stockData.inStock;
        const sizeInfo = product.sizeMapping[simpleSku];
        const size = sizeInfo?.size || '?';
        
        // Check if this size is being watched and stock became available
        if (product.watchedSizes.has(simpleSku) && wasOutOfStock && nowInStock) {
          if (!product.notified.has(simpleSku)) {
            console.log(`🚨 NEW STOCK: ${size} (${simpleSku}) - ${stockData.quantity} units!`);
            
            // Mark as notified to avoid spam
            product.notified.add(simpleSku);
            
            // Build product URL
            const productUrl = `https://www.zalando-prive.fr/campaigns/${product.productInfo.campaignId}/articles/${product.articleId}`;
            
            // Send notification (no auto add to cart due to Akamai protection)
            await sendDiscordNotification(
              product.productInfo, 
              simpleSku, 
              size, 
              stockData.quantity,
              productUrl
            );
            
            console.log(`📢 Discord notification sent!`);
          }
        }
        
        // Reset notification if item goes out of stock again (so we notify again if it comes back)
        if (product.notified.has(simpleSku) && !nowInStock) {
          product.notified.delete(simpleSku);
        }
      }
      
      product.previousStock = currentStock;
    } catch (error) {
      console.error(`[${getTimestamp()}] Error monitoring ${key}:`, error.message);
      
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('unauthorized') || 
          errorMsg.includes('401') || 
          errorMsg.includes('403') ||
          errorMsg.includes('token') ||
          errorMsg.includes('auth') ||
          errorMsg.includes('expired') ||
          errorMsg.includes('invalid')) {
        await sendTokenExpiredNotification(error.message);
      }
    }
  }
}

function startMonitoring() {
  if (!monitoringInterval) {
    monitoringInterval = setInterval(monitorAllProducts, CONFIG.checkIntervalMs);
    console.log(`⏰ Monitoring started (every ${CONFIG.checkIntervalMs / 1000}s)`);
  }
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('⏹️ Monitoring stopped');
  }
}

// ============== API ENDPOINTS ==============

app.get('/api/products', (req, res) => {
  const products = [];
  for (const [key, product] of monitoredProducts) {
    products.push({
      key,
      campaignId: product.productInfo.campaignId,
      articleId: product.articleId,
      productInfo: product.productInfo,
      sizeMapping: product.sizeMapping,
      watchedSizes: Array.from(product.watchedSizes),
      currentStock: product.previousStock,
      notified: Array.from(product.notified)
    });
  }
  res.json({ products, isMonitoring: !!monitoringInterval });
});

// Parse product URL to extract campaignId and articleId
function parseProductUrl(url) {
  // Format: https://www.zalando-prive.fr/campaigns/ZZO459V/articles/ZZO31NV42-M00
  const match = url.match(/campaigns\/([^\/]+)\/(?:categories\/[^\/]+\/)?articles\/([^\/\?]+)/);
  if (match) {
    return { campaignId: match[1], articleId: match[2] };
  }
  return null;
}

app.post('/api/products/fetch', async (req, res) => {
  try {
    let { campaignId, articleId, url } = req.body;
    
    // If URL is provided, parse it
    if (url && !campaignId) {
      const parsed = parseProductUrl(url);
      if (parsed) {
        campaignId = parsed.campaignId;
        articleId = parsed.articleId;
      }
    }
    
    if (!campaignId || !articleId) {
      return res.status(400).json({ error: 'Campaign ID and Article ID are required (or provide URL)' });
    }

    const { productInfo, sizeMapping, simpleSkus } = await fetchProductDetails(campaignId, articleId);
    
    // Get current stock
    const stockInfo = await checkStock(productInfo.configSku, simpleSkus, campaignId);
    
    res.json({
      campaignId,
      articleId,
      productInfo,
      sizes: Object.entries(sizeMapping).map(([simpleSku, info]) => ({
        simpleSku,
        size: info.size,
        inStock: stockInfo[simpleSku]?.inStock || false,
        quantity: stockInfo[simpleSku]?.quantity || 0
      }))
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Fetch error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth') ||
        errorMsg.includes('expired') ||
        errorMsg.includes('invalid')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products/add', async (req, res) => {
  try {
    const { campaignId, articleId, watchedSizes } = req.body;
    
    if (!campaignId || !articleId || !watchedSizes || !Array.isArray(watchedSizes)) {
      return res.status(400).json({ error: 'Campaign ID, Article ID, and watchedSizes array are required' });
    }

    const key = `${campaignId}-${articleId}`;
    
    const { productInfo, sizeMapping, simpleSkus } = await fetchProductDetails(campaignId, articleId);
    const stockInfo = await checkStock(productInfo.configSku, simpleSkus, campaignId);
    
    const notifiedSet = new Set();
    const productUrl = `https://www.zalando-prive.fr/campaigns/${campaignId}/articles/${articleId}`;
    
    // Check if any watched size is already in stock and send notification immediately
    for (const sku of watchedSizes) {
      const stock = stockInfo[sku];
      if (stock && stock.inStock && stock.quantity > 0) {
        const size = sizeMapping[sku]?.size || sku;
        console.log(`🚨 Size ${size} already in stock (${stock.quantity}) - sending notification!`);
        
        await sendDiscordNotification(productInfo, sku, size, stock.quantity, productUrl);
        notifiedSet.add(sku);
      }
    }
    
    monitoredProducts.set(key, {
      articleId,
      productInfo,
      sizeMapping,
      simpleSkus,
      watchedSizes: new Set(watchedSizes),
      previousStock: stockInfo,
      notified: notifiedSet
    });

    startMonitoring();

    res.json({ 
      success: true, 
      message: `Now monitoring ${productInfo.brand} - ${productInfo.title}`,
      watchedSizes: watchedSizes.map(sku => sizeMapping[sku]?.size || sku),
      alreadyInStock: Array.from(notifiedSet).map(sku => sizeMapping[sku]?.size || sku)
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Add product error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth') ||
        errorMsg.includes('expired') ||
        errorMsg.includes('invalid')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:key', (req, res) => {
  const { key } = req.params;
  
  if (monitoredProducts.has(key)) {
    monitoredProducts.delete(key);
    
    if (monitoredProducts.size === 0) {
      stopMonitoring();
    }
    
    res.json({ success: true, message: 'Product removed' });
  } else {
    res.status(404).json({ error: 'Product not found' });
  }
});

app.put('/api/products/:key/sizes', (req, res) => {
  const { key } = req.params;
  const { watchedSizes } = req.body;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.watchedSizes = new Set(watchedSizes);
  
  res.json({ success: true, watchedSizes: Array.from(product.watchedSizes) });
});

app.post('/api/products/:key/reset', (req, res) => {
  const { key } = req.params;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.notified.clear();
  
  res.json({ success: true, message: 'Cart tracking reset' });
});

app.post('/api/config/token', (req, res) => {
  const { token, refreshToken } = req.body;
  
  if (!token && !refreshToken) {
    return res.status(400).json({ error: 'Token or refreshToken is required' });
  }
  
  if (token) {
    CONFIG.authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    console.log(`[${getTimestamp()}] Access token updated via API`);
  }
  
  if (refreshToken) {
    CONFIG.refreshToken = refreshToken;
    console.log(`[${getTimestamp()}] Refresh token updated via API`);
    // Start auto-refresh if not already running
    startTokenRefresh();
  }
  
  resetTokenExpiredFlag();
  res.json({ success: true, message: 'Token(s) updated' });
});

// Manual token refresh endpoint
app.post('/api/config/refresh', async (req, res) => {
  try {
    const success = await performTokenRefresh();
    if (success) {
      res.json({ success: true, message: 'Token refreshed successfully' });
    } else {
      res.status(500).json({ error: 'Token refresh failed' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  res.json({
    status: 'alive',
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    uptimeSeconds: uptime,
    monitoredProducts: monitoredProducts.size,
    isMonitoring: !!monitoringInterval,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

// Test endpoint for add to cart
app.post('/api/test/addtocart', async (req, res) => {
  try {
    const { configSku, simpleSku, campaignId } = req.body;
    
    if (!configSku || !simpleSku || !campaignId) {
      return res.status(400).json({ error: 'configSku, simpleSku, and campaignId are required' });
    }
    
    const result = await addToCart(configSku, simpleSku, campaignId);
    res.json({ success: result.success, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const serverStartTime = new Date();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛒 Zalando Privé Stock Monitor - Web Interface              ║
║  Server running on port ${String(PORT).padEnd(37)} ║
║  Started at: ${serverStartTime.toISOString().padEnd(48)} ║
║  Health check: /health or /ping                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  
  // Start automatic token refresh if refresh token is configured
  if (CONFIG.refreshToken) {
    console.log(`[${getTimestamp()}] 🔄 Starting automatic token refresh...`);
    startTokenRefresh();
  } else {
    console.log(`[${getTimestamp()}] ⚠️ No ZALANDO_REFRESH_TOKEN configured - manual token updates required`);
  }
});
