# Production Deployment Guide 🚀

WordJS is designed to be easy to deploy. It defaults to a file-based **SQLite** database for zero-config startups, but fully supports **PostgreSQL** for high-scale external database needs.

---

## 📋 Prerequisites

- **Node.js:** v18 or higher.
- **PM2:** (Recommended) A process manager for Node.js to keep your app alive.
  ```bash
  npm install -g pm2
  ```

---

## 🛠️ Installation Steps

### 1. Clone & Install
```bash
git clone <your-repo-url>
cd wordjs
npm install
cd backend && npm install
cd ../admin-next && npm install
```

### 2. Build the Frontend
The frontend must be compiled for production to ensure maximum speed.
```bash
cd admin-next
npm run build
cd ..
```

### 3. Configure the Site
You have two options for production:

**A. Using the Wizard (Easiest)**
1. Start the app (see next step).
2. Visit your server's IP/Domain on port 3000.
3. Follow the UI installer.

**B. Using Environment Variables**
Create/Edit `.env` files if you want to lock the configuration.
*   `SITE_URL`: Your public domain (e.g., `https://my-site.com`).
*   `NODE_ENV`: Set to `production`.

---

## 🏃 Run in Production

We recommend using **PM2** to manage the three components (Gateway, Backend, Frontend).

### A. Automatic (using concurrently)
You can use the root script but it's less granular for logs:
```bash
pm2 start "npm start" --name wordjs
```

### B. Granular (Recommended)
This allows you to restart individual services if needed.

```bash
# Start Gateway
pm2 start gateway.js --name "wordjs-gateway"

# Start Backend
cd backend
pm2 start src/index.js --name "wordjs-backend"

# Start Frontend
cd ../admin-next
pm2 start "npm run start -- -p 3001" --name "wordjs-frontend"
```

---

## 🔒 Security Checklist

1.  **Firewall:** Only open port `3000` (Gateway) to the public. Ports `4000` (Backend) and `3001` (Frontend) should stay internal.
2.  **HTTPS:** Use a service like **Cloudflare** or a simple **Nginx Reverse Proxy** on top of the Gateway to handle SSL (Certbot).
3.  **Secrets:** Ensure your `gatewaySecret` in `wordjs-config.json` is a long, random string.

---

## 🔄 Updates

To update the CMS:
```bash
git pull
npm install
cd admin-next && npm install && npm run build
pm2 restart all
```
