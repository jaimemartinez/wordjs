# WordJS

A WordPress-like CMS built with Node.js, Express, and SQLite.

## Features

- 🚀 **REST API** - Full REST API compatible with WordPress patterns
- 🔐 **JWT Authentication** - Secure token-based authentication
- 🔌 **Hook System** - WordPress-like actions and filters

## Project Structure

- `src/`: Core CMS logic (Node.js)
- `admin-next/`: New Modern Admin Panel (Next.js)
- `themes/`: Theme files
- `plugins/`: Plugin files
- `uploads/`: Media uploads

## Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   cd admin-next && npm install && cd ..
   ```

2. **Start Development Servers**
   You need to run both the backend and frontend servers:

   **Backend (API & Site):**
   ```bash
   npm run dev
   # Runs on http://localhost:3000
   ```

   **Admin Panel (Next.js):**
   ```bash
   cd admin-next
   npm run dev -- -p 3001
   # Runs on http://localhost:3001
   ```

3. **Access**
   - **Website**: [http://localhost:3000](http://localhost:3000)
   - **Admin Panel**: [http://localhost:3001/login](http://localhost:3001/login)
     - Username: `admin`
     - Password: `admin123`
   - **API Documentation**: [http://localhost:3000/api/v1](http://localhost:3000/api/v1)

## Default Admin

On first run, a default admin user is created:

- **Username:** admin
- **Password:** admin123

⚠️ **Change this password immediately in production!**

## API Endpoints

Base URL: `/api/v1`

### Authentication

| Method | Endpoint         | Description         |
| ------ | ---------------- | ------------------- |
| POST   | `/auth/register` | Register new user   |
| POST   | `/auth/login`    | Login and get token |
| GET    | `/auth/me`       | Get current user    |
| POST   | `/auth/refresh`  | Refresh token       |

### Posts

| Method | Endpoint     | Description     |
| ------ | ------------ | --------------- |
| GET    | `/posts`     | List posts      |
| GET    | `/posts/:id` | Get single post |
| POST   | `/posts`     | Create post     |
| PUT    | `/posts/:id` | Update post     |
| DELETE | `/posts/:id` | Delete post     |

### Users

| Method | Endpoint     | Description         |
| ------ | ------------ | ------------------- |
| GET    | `/users`     | List users          |
| GET    | `/users/:id` | Get single user     |
| POST   | `/users`     | Create user (admin) |
| PUT    | `/users/:id` | Update user         |
| DELETE | `/users/:id` | Delete user (admin) |

### Categories & Tags

| Method | Endpoint      | Description     |
| ------ | ------------- | --------------- |
| GET    | `/categories` | List categories |
| POST   | `/categories` | Create category |
| GET    | `/tags`       | List tags       |
| POST   | `/tags`       | Create tag      |

### Comments

| Method | Endpoint        | Description    |
| ------ | --------------- | -------------- |
| GET    | `/comments`     | List comments  |
| POST   | `/comments`     | Create comment |
| PUT    | `/comments/:id` | Update comment |
| DELETE | `/comments/:id` | Delete comment |

### Media

| Method | Endpoint     | Description  |
| ------ | ------------ | ------------ |
| GET    | `/media`     | List media   |
| POST   | `/media`     | Upload file  |
| DELETE | `/media/:id` | Delete media |

### Settings

| Method | Endpoint    | Description             |
| ------ | ----------- | ----------------------- |
| GET    | `/settings` | Get public settings     |
| PUT    | `/settings` | Update settings (admin) |

## Authentication

Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-token>
```

## Example Usage

### Login

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### Create Post

```bash
curl -X POST http://localhost:3000/api/v1/posts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello World","content":"My first post!","status":"publish"}'
```

### List Posts

```bash
curl http://localhost:3000/api/v1/posts
```

## User Roles

- **administrator** - Full access
- **editor** - Manage all content
- **author** - Create and manage own posts
- **contributor** - Create posts (no publishing)
- **subscriber** - Read only

## License

GPL-3.0
