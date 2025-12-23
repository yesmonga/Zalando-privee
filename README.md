# Zalando Privé Stock Monitor 🛒

Bot de surveillance de stock Zalando Privé avec ajout automatique au panier et notifications Discord.

## Fonctionnalités

- ✅ Interface web mobile-friendly pour gérer les produits
- ✅ Surveillance automatique du stock toutes les 60 secondes
- ✅ Ajout automatique au panier dès qu'une taille surveillée revient en stock
- ✅ Notifications Discord avec deadline de checkout (~20 min)
- ✅ Support multi-produits
- ✅ Parsing automatique des URLs Zalando Privé

## Déploiement sur Railway

1. Créez un nouveau projet sur [Railway](https://railway.app)
2. Connectez votre repo GitHub
3. Configurez les **variables d'environnement** dans Railway :

| Variable | Valeur |
|----------|--------|
| `ZALANDO_TOKEN` | `Bearer eyJraWQiOiI2MDBqa...` (token complet avec "Bearer ") |
| `DISCORD_WEBHOOK` | `https://discord.com/api/webhooks/...` |

4. Railway détectera automatiquement Node.js et lancera `npm start`

## Variables d'environnement (OBLIGATOIRES)

| Variable | Description | Exemple |
|----------|-------------|---------|
| `ZALANDO_TOKEN` | Token Bearer JWT complet (avec "Bearer ") | `Bearer eyJraWQi...` |
| `DISCORD_WEBHOOK` | URL complète du webhook Discord | `https://discord.com/api/webhooks/...` |

## Utilisation

1. Ouvrez l'interface web sur votre téléphone
2. Collez l'URL du produit **OU** entrez Campaign ID + Article ID
3. Cliquez sur "Rechercher"
4. Sélectionnez les tailles à surveiller (celles en rupture)
5. Cliquez sur "Ajouter au monitoring"

Le bot surveillera le stock et ajoutera automatiquement au panier + enverra une notification Discord dès qu'une taille revient en stock.

## Format des URLs

```
https://www.zalando-prive.fr/campaigns/ZZO459V/articles/ZZO31NV42-M00
https://www.zalando-prive.fr/campaigns/ZZO459V/categories/200814106/articles/ZZO31NV42-M00
```

## ⚠️ Mise à jour du token

Le token JWT expire régulièrement. Pour le mettre à jour :

1. Via l'interface web : Section "Paramètres du token"
2. Collez le token (avec ou sans "Bearer ")
3. L'app ajoutera automatiquement le préfixe si nécessaire

**OU** mettez à jour la variable `ZALANDO_TOKEN` dans Railway

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Interface web |
| `/health` | Status du serveur (pour UptimeRobot) |
| `/ping` | Ping simple |

## Structure

```
├── server.js          # Serveur Express + logique de monitoring
├── public/
│   └── index.html     # Interface web mobile-friendly
├── package.json
└── README.md
```
