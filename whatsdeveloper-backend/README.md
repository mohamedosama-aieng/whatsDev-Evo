# WhatsDeveloper Backend Bridge API

Backend API bridge that translates WhatsDeveloper API calls to Evolution API format.

## 🚀 Features

- ✅ **API Compatibility**: Same endpoints & parameters as WhatsDeveloper
- ✅ **Evolution Integration**: Internally forwards to Evolution API
- ✅ **Interactive Docs**: Built-in Swagger UI at `/api-docs`
- ✅ **Type Safety**: Full TypeScript implementation
- ✅ **Rate Limiting**: Protect against abuse
- ✅ **CORS Enabled**: Ready for frontend integration

---

## 📦 Installation

```bash
npm install
```

---

## ⚙️ Configuration

Create `.env` file:

```bash
# Server
PORT=3000
NODE_ENV=development

# Evolution API
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=your-evolution-api-key
DEFAULT_INSTANCE_NAME=TEST
# Optional: maximum wait for Evolution media requests (default 120000 ms)
EVOLUTION_MEDIA_TIMEOUT_MS=120000

# Security
JWT_SECRET=your-secret-key

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# CORS
CORS_ORIGIN=http://localhost:5173
```

---

## 🏃 Running

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

---

## 📚 API Documentation

Once running, visit: **http://localhost:3000/api-docs**

---

## 🔌 Endpoints

### Messages

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/send-message` | POST | Send text message |
| `/api/send-image` | POST | Send image with caption |
| `/api/send-video` | POST | Send video with caption |
| `/api/send-audio` | POST | Send audio |
| `/api/send-document` | POST | Send document/file |
| `/api/send-location` | POST | Send location |
| `/api/send-contact` | POST | Send contact card |
| `/api/send-buttons` | POST | Send buttons/list message |
| `/api/v1/messages/send-sequence` | POST | Queue an ordered sequence and return its ID |
| `/api/v1/messages/send-sequence/:sequenceId` | GET | Read sequence progress and per-message results |

Sequence submission returns HTTP 202 immediately. Poll the returned `statusUrl` with the same authentication until `status` is `completed` or `completed_with_errors`. An optional `Idempotency-Key` header makes a repeated submission return the existing job instead of creating a duplicate. Per-message `unknown` means Evolution timed out after accepting the request may already have reached WhatsApp; verify delivery before retrying that item. Sequence state currently lives in backend memory and is lost on a backend restart.

### Instance & Chats

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/instance/status` | GET | Get connection status |
| `/api/chats` | GET | Get all chats |
| `/api/messages/:phone` | GET | Get messages for chat |

---

## 📖 Usage Examples

### Send Text Message

```bash
curl -X POST http://localhost:3000/api/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "201234567890",
    "message": "Hello from WhatsDeveloper!"
  }'
```

### Send Image

```bash
curl -X POST http://localhost:3000/api/send-image \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "201234567890",
    "image": "https://example.com/image.jpg",
    "caption": "Check this out!"
  }'
```

### Get Instance Status

```bash
curl http://localhost:3000/api/instance/status
```

---

## 🏗️ Architecture

```
WhatsDeveloper Manager (Frontend)
         ↓
Backend Bridge API (Port 3000)
         ↓
Evolution API (Port 8080)
         ↓
WhatsApp
```

---

## 🔧 Technology Stack

- **Node.js** + **TypeScript**
- **Express.js** - Web framework
- **Axios** - HTTP client for Evolution API
- **Swagger** - API documentation
- **Helmet** - Security headers
- **express-rate-limit** - Rate limiting

---

## 📝 Response Format

All responses follow this format:

**Success:**
```json
{
  "success": true,
  "data": { ... }
}
```

**Error:**
```json
{
  "success": false,
  "error": "Error message"
}
```

---

## 🛡️ Security

- Rate limiting (100 requests/minute by default)
- Helmet security headers
- CORS protection
- Environment variable configuration

---

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

---

## 📄 License

ISC

---

## 👨‍💻 Author

**DevDodge / DK-Octobot**

---

## 🔗 Related Projects

- [Evolution API](https://github.com/EvolutionAPI/evolution-api)
- [WhatsDeveloper Manager](../WhatsDeveloper-Manager)
