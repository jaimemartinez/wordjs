# WordJS Gateway Documentation

The **WordJS Gateway** (`gateway.js`) is the central entry point for the application. It acts as a reverse proxy and service registry, routing requests to the appropriate microservices (Backend, Frontend, etc.) based on their registration.

## Key Features

*   **Reverse Proxy:** Uses `http-proxy` to forward requests transparently.
*   **Service Registry:** Services register themselves dynamically via the `/register` endpoint.
*   **Security:** Protected by `GATEWAY_SECRET` (auto-generated in `wordjs-config.json`).
*   **Rate Limiting:** Built-in global rate limiting to prevent abuse.
*   **Zero Config:** Automatically detects ports from `wordjs-config.json`.

## Configuration

The gateway attempts to load configuration from `backend/wordjs-config.json`.

*   **Port:** Defaults to `3000` (or `gatewayPort` in config).
*   **Secret:** Uses `gatewaySecret` from config for service authentication.

## Service Registration

Internal services (Backend, Frontend) must register themselves on startup.

**Endpoint:** `POST /register`
**Headers:** `x-gateway-secret: <YOUR_SECRET>`
**Body:**
```json
{
  "name": "backend",
  "url": "http://localhost:4000",
  "routes": ["/api", "/uploads", "/themes", "/plugins"]
}
```

## Routing Logic

1.  Checks if the incoming URL path matches a registered prefix.
2.  If matched (e.g., `/api` -> Backend), forwards the request preserving the `Host` header.
3.  If no match, returns 404.

## Production vs. Development

*   **Development:** You might see mismatched Host headers if accessing `localhost:3000` directly while configured for `3001`. The Backend includes a specific exception for this `localhost:3000` mismatch in `NODE_ENV=development`.
*   **Production:** The Gateway sits behind your domain (e.g., `mysite.com`). Traffic flows `User -> Gateway -> Service`. The `Host` header (`mysite.com`) is preserved, so no URL mismatch errors occur.
