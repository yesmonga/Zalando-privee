const express = require('express');
const https = require('https');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Configuration - All sensitive data from environment variables
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkoutUrl: "https://www.zalando-prive.fr/checkout",
  cartReservationMinutes: 20,
  checkIntervalMs: 60 * 1000,
  authorization: process.env.ZALANDO_TOKEN || "",
  refreshToken: process.env.ZALANDO_REFRESH_TOKEN || "",
  salesChannel: "a332da49-a665-4a13-bd44-1ecea09b4d86",
  appDomainId: "18",
  tokenRefreshIntervalMs: 50 * 60 * 1000, // Refresh every 50 minutes (token expires in 60 min)
  autoAddToCart: true // Enable automatic add to cart when stock is detected
};

// Session data for Akamai protection (updated via API or environment)
const SESSION = {
  cookies: {
    _abck: process.env.AKAMAI_ABCK || "",
    ak_bmsc: process.env.AKAMAI_BMSC || "",
    bm_sz: process.env.AKAMAI_BMSZ || ""
  },
  sensorData: process.env.AKAMAI_SENSOR_DATA || "",
  lastUpdated: null
};

// Token refresh interval reference
let tokenRefreshInterval = null;
let lastTokenRefresh = null;

// Cart auto-prolongation interval reference
let cartProlongInterval = null;
const CART_PROLONG_INTERVAL_MS = 18 * 60 * 1000; // 18 minutes

// Store monitored products
const monitoredProducts = new Map();

// Product history (persists across monitoring sessions)
const productHistory = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// Add product to history
function addToHistory(campaignId, articleId, productInfo, sizeMapping) {
  const key = `${campaignId}-${articleId}`;
  productHistory.set(key, {
    campaignId,
    articleId,
    title: productInfo.title || `Produit ${articleId}`,
    brand: productInfo.brand,
    color: productInfo.color,
    price: productInfo.price,
    sizeMapping,
    addedAt: new Date().toISOString(),
    lastMonitored: new Date().toISOString()
  });
}

// ============== ZALANDO API FUNCTIONS ==============

function makeRequest(method, path, body = null, isCartRequest = false) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;

    const headers = {
      'User-Agent': 'Client/ios-app AppVersion/615 AppVersionName/4.72.1 AppDomain/18 OS/26.2',
      'X-Device-Type': 'smartphone',
      'X-Zalando-Client-Id': '53BEFF53-D469-4DDA-913E-33F4555D2CEE',
      'X-Device-OS': 'iOS',
      'X-Flow-Id': `I${Date.now().toString(16).toUpperCase()}-${Math.random().toString(16).slice(2, 6)}-${Math.floor(Math.random() * 100)}`,
      'ot-baggage-traffic_src': 'deeplink',
      'X-Sales-Channel': CONFIG.salesChannel,
      'X-App-Version': '4.72.1',
      'Authorization': CONFIG.authorization,
      'zmobile-os': 'ios',
      'Accept-Language': 'fr-FR',
      'X-APPDOMAINID': CONFIG.appDomainId,
      'CLIENT_TYPE': 'ios-app',
      'Accept': 'application/json,application/problem+json',
      'Content-Type': 'application/json',
      'X-IOS-VERSION': '4.72.1',
      'X-API-VERSION': 'v1',
      'Connection': 'keep-alive',
      'Accept-Encoding': 'gzip, deflate'
    };

    // Add cart-specific headers including Akamai protection
    if (isCartRequest) {
      headers['x-enable-unreserved-cart'] = 'true';
      
      // Add Akamai cookies if available
      const cookieParts = [];
      if (SESSION.cookies._abck) cookieParts.push(`_abck=${SESSION.cookies._abck}`);
      if (SESSION.cookies.ak_bmsc) cookieParts.push(`ak_bmsc=${SESSION.cookies.ak_bmsc}`);
      if (SESSION.cookies.bm_sz) cookieParts.push(`bm_sz=${SESSION.cookies.bm_sz}`);
      
      if (cookieParts.length > 0) {
        headers['Cookie'] = cookieParts.join('; ');
      }
      
      // Add sensor data if available
      if (SESSION.sensorData) {
        headers['X-acf-sensor-data'] = SESSION.sensorData;
      }
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
      let chunks = [];
      
      // Handle gzip/deflate compression
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        stream = res.pipe(require('zlib').createGunzip());
      } else if (res.headers['content-encoding'] === 'deflate') {
        stream = res.pipe(require('zlib').createInflate());
      }
      
      stream.on('data', (chunk) => { chunks.push(chunk); });
      stream.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        
        // Check for HTTP-level auth errors
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Unauthorized (${res.statusCode}) - Token expired or invalid`));
          return;
        }
        
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
          return;
        }
        
        // Handle empty response (e.g., 204 No Content)
        if (!data || data.trim() === '') {
          resolve({});
          return;
        }
        
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message}`));
        }
      });
      stream.on('error', (error) => reject(error));
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

async function addToCart(configSku, simpleSku, campaignId, useAkamai = true) {
  const path = '/stockcart/cart/items';
  const body = {
    campaignIdentifier: campaignId,
    quantity: "1",
    simpleSku: simpleSku,
    configSku: configSku
  };

  console.log(`[${getTimestamp()}] 🛒 Attempting to add to cart: ${simpleSku} (Akamai: ${useAkamai})`);
  
  try {
    const response = await makeRequest('POST', path, body, useAkamai); // isCartRequest controls Akamai headers
    
    // Check if item was added successfully
    if (response && response.items && response.items.length > 0) {
      const addedItem = response.items.find(item => item.simpleSku === simpleSku);
      console.log(`[${getTimestamp()}] ✅ Successfully added to cart: ${simpleSku}`);
      
      // Start auto-prolongation when item is added
      startCartProlongation();
      
      return {
        success: true,
        remainingSeconds: response.remainingLifetimeSeconds || 1200,
        cartType: response.cartType,
        item: addedItem,
        totalItems: response.items.length
      };
    }
    
    console.log(`[${getTimestamp()}] ❌ Add to cart failed - no items in response`);
    return { success: false, error: 'No items in response' };
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Add to cart error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============== CART MANAGEMENT ==============

async function getCart() {
  const path = '/stockcart/cart';
  
  console.log(`[${getTimestamp()}] 🛒 Checking cart contents...`);
  
  try {
    const response = await makeRequest('GET', path, null, true); // isCartRequest = true for Akamai headers
    
    if (response && response.items) {
      console.log(`[${getTimestamp()}] ✅ Cart has ${response.items.length} items, ${response.remainingLifetimeSeconds}s remaining`);
      
      return {
        success: true,
        items: response.items,
        totalItems: response.items.length,
        remainingSeconds: response.remainingLifetimeSeconds,
        prolongCounter: response.prolongCounter || 0,
        expired: response.expired,
        cartType: response.cartType,
        price: response.price
      };
    }
    
    return { success: true, items: [], totalItems: 0 };
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Get cart error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function extendCart() {
  const path = '/stockcart/cart';
  
  console.log(`[${getTimestamp()}] ⏰ Extending cart reservation...`);
  
  try {
    // PUT returns 204 No Content on success, so we make the request then fetch cart state
    await makeRequest('PUT', path, null, true);
    
    // Fetch updated cart state
    const cartState = await getCart();
    
    if (cartState.success) {
      const minutes = Math.floor(cartState.remainingSeconds / 60);
      console.log(`[${getTimestamp()}] ✅ Cart extended! ${minutes} minutes remaining (prolong #${cartState.prolongCounter || 1})`);
      
      return {
        success: true,
        remainingSeconds: cartState.remainingSeconds,
        prolongCounter: cartState.prolongCounter || 1,
        items: cartState.items,
        totalItems: cartState.totalItems,
        cartType: cartState.cartType
      };
    }
    
    return { success: false, error: 'Failed to get cart state after extend' };
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Extend cart error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ============== CART AUTO-PROLONGATION ==============

async function checkAndProlongCart() {
  console.log(`[${getTimestamp()}] 🔄 Auto-prolong: Checking cart...`);
  
  try {
    const cartState = await getCart();
    
    if (cartState.success && cartState.totalItems > 0) {
      console.log(`[${getTimestamp()}] 🛒 Cart has ${cartState.totalItems} items, extending...`);
      const extendResult = await extendCart();
      
      if (extendResult.success) {
        const minutes = Math.floor(extendResult.remainingSeconds / 60);
        console.log(`[${getTimestamp()}] ✅ Auto-prolong: Cart extended! ${minutes} min remaining (prolong #${extendResult.prolongCounter})`);
      } else {
        console.log(`[${getTimestamp()}] ❌ Auto-prolong failed: ${extendResult.error}`);
      }
    } else {
      console.log(`[${getTimestamp()}] 📭 Cart is empty, stopping auto-prolongation`);
      stopCartProlongation();
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Auto-prolong error: ${error.message}`);
  }
}

function startCartProlongation() {
  if (cartProlongInterval) {
    console.log(`[${getTimestamp()}] ⏰ Cart prolongation already running`);
    return;
  }
  
  console.log(`[${getTimestamp()}] ⏰ Starting cart auto-prolongation (every 18 min)`);
  cartProlongInterval = setInterval(checkAndProlongCart, CART_PROLONG_INTERVAL_MS);
}

function stopCartProlongation() {
  if (cartProlongInterval) {
    clearInterval(cartProlongInterval);
    cartProlongInterval = null;
    console.log(`[${getTimestamp()}] ⏹️ Cart auto-prolongation stopped`);
  }
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

function sendDiscordNotification(productInfo, simpleSku, size, quantity, productUrl, cartResult = null) {
  const checkoutUrl = 'https://www.zalando-prive.fr/checkout';
  
  // Determine if item was added to cart
  const addedToCart = cartResult && cartResult.success;
  const title = addedToCart ? "✅ AJOUTÉ AU PANIER!" : "🚨 STOCK DISPONIBLE!";
  const color = addedToCart ? 0x22c55e : 0xff6900; // Green if added, orange if just detected
  
  const fields = [
    { name: "👕 Produit", value: `**${productInfo.brand} - ${productInfo.title}**`, inline: false },
    { name: "🎨 Couleur", value: productInfo.color || '-', inline: true },
    { name: "📏 Taille", value: `**${size}**`, inline: true },
    { name: "📦 Quantité", value: `${quantity} dispo`, inline: true },
    { name: "💰 Prix", value: `${productInfo.price} (${productInfo.discount})`, inline: false }
  ];
  
  if (addedToCart) {
    const minutes = Math.floor(cartResult.remainingSeconds / 60);
    fields.push({ name: "⏱️ Réservation", value: `${minutes} minutes restantes`, inline: true });
    fields.push({ name: "🛒 Checkout", value: `[FINALISER L'ACHAT](${checkoutUrl})`, inline: true });
  } else {
    fields.push({ name: "🔗 Lien produit", value: `[Voir le produit](${productUrl})`, inline: true });
    fields.push({ name: "🛒 Checkout", value: `[Aller au panier](${checkoutUrl})`, inline: true });
    
    if (cartResult && cartResult.error) {
      fields.push({ name: "⚠️ Erreur ajout panier", value: `\`${cartResult.error}\``, inline: false });
    }
  }
  
  const embed = {
    title: title,
    color: color,
    fields: fields,
    footer: { text: `SKU: ${simpleSku}` },
    timestamp: new Date().toISOString()
  };

  const content = addedToCart 
    ? "@everyone ✅ **ARTICLE RÉSERVÉ - FINALISEZ VOTRE ACHAT!**"
    : "@everyone 🚨 **NOUVEAU STOCK - AJOUTE VITE AU PANIER!**";

  return sendDiscordWebhook({
    content: content,
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

// ============== TOKEN REFRESH LOGIC ==============

async function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    if (!CONFIG.refreshToken) {
      reject(new Error('No refresh token available'));
      return;
    }

    const postData = `grant_type=refresh_token&refresh_token=${encodeURIComponent(CONFIG.refreshToken)}&client_id=lounge`;

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
          
          if (res.statusCode !== 200 || !response.access_token) {
            reject(new Error(`Token refresh failed: ${res.statusCode} - ${data}`));
            return;
          }
          
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.write(postData);
    req.end();
  });
}

function sendTokenRefreshSuccessNotification() {
  const embed = {
    title: "✅ TOKEN RAFRAÎCHI",
    color: 0x22c55e, // Green
    description: "Le token Zalando Privé a été automatiquement rafraîchi.",
    fields: [
      { name: "⏰ Prochain rafraîchissement", value: "Dans ~50 minutes", inline: false }
    ],
    footer: { text: "Zalando Privé Monitor - Auto Refresh" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    embeds: [embed]
  });
}

function sendTokenRefreshFailedNotification(errorMessage) {
  const embed = {
    title: "❌ ÉCHEC RAFRAÎCHISSEMENT TOKEN",
    color: 0xf87171, // Red
    description: "Le rafraîchissement automatique du token a échoué. Intervention manuelle requise.",
    fields: [
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false },
      { name: "🔧 Action requise", value: "Mettez à jour le refresh_token via l'interface web", inline: false }
    ],
    footer: { text: "Zalando Privé Monitor" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone ❌ **ÉCHEC RAFRAÎCHISSEMENT - INTERVENTION REQUISE!**",
    embeds: [embed]
  });
}

async function performTokenRefresh() {
  console.log(`[${getTimestamp()}] 🔄 Attempting token refresh...`);
  
  try {
    const tokenData = await refreshAccessToken();
    
    // Update tokens in CONFIG
    CONFIG.authorization = `Bearer ${tokenData.access_token}`;
    if (tokenData.refresh_token) {
      CONFIG.refreshToken = tokenData.refresh_token;
    }
    
    lastTokenRefresh = new Date();
    resetTokenExpiredFlag();
    
    console.log(`[${getTimestamp()}] ✅ Token refreshed successfully!`);
    
    // Send success notification
    await sendTokenRefreshSuccessNotification();
    
    return true;
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Token refresh failed:`, error.message);
    
    // Send failure notification
    await sendTokenRefreshFailedNotification(error.message);
    
    return false;
  }
}

function startTokenRefresh() {
  if (tokenRefreshInterval) {
    console.log('Token refresh already running');
    return;
  }
  
  if (!CONFIG.refreshToken) {
    console.log('⚠️ No refresh token configured - automatic refresh disabled');
    return;
  }
  
  console.log(`🔄 Token auto-refresh started (every ${CONFIG.tokenRefreshIntervalMs / 60000} minutes)`);
  
  // Refresh immediately on start
  performTokenRefresh();
  
  // Then refresh every 50 minutes
  tokenRefreshInterval = setInterval(performTokenRefresh, CONFIG.tokenRefreshIntervalMs);
}

function stopTokenRefresh() {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
    console.log('Token refresh stopped');
  }
}

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
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
            
            // Try to auto add to cart if enabled
            let cartResult = null;
            if (CONFIG.autoAddToCart) {
              cartResult = await addToCart(
                product.productInfo.configSku,
                simpleSku,
                product.productInfo.campaignId
              );
            }
            
            // Send notification with cart result
            await sendDiscordNotification(
              product.productInfo, 
              simpleSku, 
              size, 
              stockData.quantity,
              productUrl,
              cartResult
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
    
    // Check if any watched size is already in stock and try to add to cart
    const addedToCart = [];
    for (const sku of watchedSizes) {
      const stock = stockInfo[sku];
      if (stock && stock.inStock && stock.quantity > 0) {
        const size = sizeMapping[sku]?.size || sku;
        console.log(`🚨 Size ${size} already in stock (${stock.quantity})!`);
        
        // Try to auto add to cart if enabled
        let cartResult = null;
        if (CONFIG.autoAddToCart) {
          cartResult = await addToCart(productInfo.configSku, sku, campaignId);
          if (cartResult.success) {
            addedToCart.push(size);
          }
        }
        
        await sendDiscordNotification(productInfo, sku, size, stock.quantity, productUrl, cartResult);
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
    
    // Save to history
    addToHistory(campaignId, articleId, productInfo, sizeMapping);

    startMonitoring();

    res.json({ 
      success: true, 
      message: `Now monitoring ${productInfo.brand} - ${productInfo.title}`,
      watchedSizes: watchedSizes.map(sku => sizeMapping[sku]?.size || sku),
      alreadyInStock: Array.from(notifiedSet).map(sku => sizeMapping[sku]?.size || sku),
      addedToCart: addedToCart
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

// ============== HISTORY API ==============

// Get product history
app.get('/api/history', (req, res) => {
  const history = [];
  for (const [key, item] of productHistory) {
    history.push({
      key,
      campaignId: item.campaignId,
      articleId: item.articleId,
      title: item.title,
      brand: item.brand,
      color: item.color,
      price: item.price,
      sizeMapping: item.sizeMapping,
      addedAt: item.addedAt,
      lastMonitored: item.lastMonitored,
      isCurrentlyMonitored: monitoredProducts.has(key)
    });
  }
  // Sort by lastMonitored (most recent first)
  history.sort((a, b) => new Date(b.lastMonitored) - new Date(a.lastMonitored));
  res.json({ history });
});

// Clear history
app.delete('/api/history', (req, res) => {
  productHistory.clear();
  res.json({ success: true, message: 'History cleared' });
});

// Remove single item from history
app.delete('/api/history/:key', (req, res) => {
  const { key } = req.params;
  if (productHistory.has(key)) {
    productHistory.delete(key);
    res.json({ success: true, message: 'Item removed from history' });
  } else {
    res.status(404).json({ error: 'Item not found in history' });
  }
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
    
    // Restart token refresh if not running
    if (!tokenRefreshInterval && CONFIG.refreshToken) {
      startTokenRefresh();
    }
  }
  
  resetTokenExpiredFlag();
  res.json({ success: true, message: 'Token(s) updated' });
});

// Endpoint to manually trigger token refresh
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

// Endpoint to update session data (Akamai cookies and sensor data)
app.post('/api/config/session', (req, res) => {
  const { cookies, sensorData, clearSensorData } = req.body;
  
  if (!cookies && sensorData === undefined && !clearSensorData) {
    return res.status(400).json({ error: 'cookies, sensorData, or clearSensorData is required' });
  }
  
  if (clearSensorData) {
    SESSION.sensorData = "";
    console.log(`[${getTimestamp()}] Akamai sensor data cleared`);
  }
  
  if (cookies) {
    if (cookies._abck) SESSION.cookies._abck = cookies._abck;
    if (cookies.ak_bmsc) SESSION.cookies.ak_bmsc = cookies.ak_bmsc;
    if (cookies.bm_sz) SESSION.cookies.bm_sz = cookies.bm_sz;
    console.log(`[${getTimestamp()}] Akamai cookies updated via API`);
  }
  
  if (sensorData) {
    SESSION.sensorData = sensorData;
    console.log(`[${getTimestamp()}] Akamai sensor data updated via API`);
  }
  
  SESSION.lastUpdated = new Date().toISOString();
  
  res.json({ 
    success: true, 
    message: 'Session data updated',
    hasCookies: !!(SESSION.cookies._abck || SESSION.cookies.ak_bmsc || SESSION.cookies.bm_sz),
    hasSensorData: !!SESSION.sensorData,
    lastUpdated: SESSION.lastUpdated
  });
});

// Get session status
app.get('/api/config/session', (req, res) => {
  res.json({
    hasCookies: !!(SESSION.cookies._abck || SESSION.cookies.ak_bmsc || SESSION.cookies.bm_sz),
    hasSensorData: !!SESSION.sensorData,
    lastUpdated: SESSION.lastUpdated,
    autoAddToCart: CONFIG.autoAddToCart
  });
});

// Toggle auto add to cart
app.post('/api/config/autocart', (req, res) => {
  const { enabled } = req.body;
  
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  
  CONFIG.autoAddToCart = enabled;
  console.log(`[${getTimestamp()}] Auto add to cart ${enabled ? 'enabled' : 'disabled'}`);
  
  res.json({ success: true, autoAddToCart: CONFIG.autoAddToCart });
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
    tokenAutoRefresh: !!tokenRefreshInterval,
    lastTokenRefresh: lastTokenRefresh ? lastTokenRefresh.toISOString() : null,
    hasRefreshToken: !!CONFIG.refreshToken,
    autoAddToCart: CONFIG.autoAddToCart,
    cartAutoProlongation: !!cartProlongInterval,
    hasSessionCookies: !!(SESSION.cookies._abck || SESSION.cookies.ak_bmsc || SESSION.cookies.bm_sz),
    hasSensorData: !!SESSION.sensorData,
    sessionLastUpdated: SESSION.lastUpdated,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

// Test endpoint for add to cart
app.post('/api/test/addtocart', async (req, res) => {
  try {
    const { configSku, simpleSku, campaignId, useAkamai } = req.body;
    
    if (!configSku || !simpleSku || !campaignId) {
      return res.status(400).json({ error: 'configSku, simpleSku, and campaignId are required' });
    }
    
    // Allow testing with or without Akamai headers
    const result = await addToCart(configSku, simpleSku, campaignId, useAkamai !== false);
    res.json({ success: result.success, result, usedAkamai: useAkamai !== false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get cart contents
app.get('/api/cart', async (req, res) => {
  try {
    const result = await getCart();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Extend cart reservation (prolong)
app.put('/api/cart/extend', async (req, res) => {
  try {
    const result = await extendCart();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Also support POST for extend (easier to call)
app.post('/api/cart/extend', async (req, res) => {
  try {
    const result = await extendCart();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start/stop cart auto-prolongation
app.post('/api/cart/autoprolong', (req, res) => {
  const { enabled } = req.body;
  
  if (enabled === true) {
    startCartProlongation();
    res.json({ success: true, message: 'Cart auto-prolongation started', interval: '18 minutes' });
  } else if (enabled === false) {
    stopCartProlongation();
    res.json({ success: true, message: 'Cart auto-prolongation stopped' });
  } else {
    res.json({ 
      isRunning: !!cartProlongInterval,
      interval: '18 minutes',
      message: 'Send {enabled: true/false} to start/stop'
    });
  }
});

// Manually trigger cart check and prolong
app.post('/api/cart/autoprolong/now', async (req, res) => {
  try {
    await checkAndProlongCart();
    res.json({ success: true, message: 'Cart check and prolong triggered' });
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
    startTokenRefresh();
  } else {
    console.log('⚠️ No ZALANDO_REFRESH_TOKEN configured - automatic token refresh disabled');
  }
});
