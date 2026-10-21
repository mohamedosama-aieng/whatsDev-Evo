# Send Messages API

External REST API for sending WhatsApp messages of all supported types.

- **Base URL:** `https://<your-host>/api/v1`
- **Mount point:** `server.js` → `app.use('/api/v1', externalApiRoutes)`
- **Content-Type:** `application/json`

---

## Authentication

Every endpoint requires an API key (middleware `authenticateApiKey`, applied to all routes). Keys start with the prefix `wa_` and are SHA-256 hashed in the `api_keys` table.

Pass the key in **any** of these three ways:

| Method               | Example                               |
| -------------------- | ------------------------------------- |
| Authorization header | `Authorization: Bearer wa_xxxxxxxx` |
| Custom header        | `X-API-Key: wa_xxxxxxxx`            |
| Query parameter      | `?api_key=wa_xxxxxxxx`              |

On success the API resolves the device (row from `clients`) and attaches it to the request. Each authenticated call updates the key's `last_used_at`.

**Auth failure response (401):**

```json
{ "success": false, "error": "Invalid or missing API key" }
```

---

## How sending works — asynchronous, queued sequence

This is the single most important behavior to understand.

Every send endpoint does **not** deliver the message during the HTTP request. Instead it:

1. **Validates** the request and recipient.
2. **Creates a queue entry** in `api_message_queue` with status `queued`.
3. **Responds immediately** with that queue entry's `messageId` and `status: "queued"`.
4. **Delivers in the background** (via `setImmediate`), moving the entry through the status lifecycle.

So the HTTP `200` you get back means **"accepted and queued"**, not "delivered". Messages are processed as an **ordered async sequence** behind the response — the queue entry is the handle you use to track the real outcome.

To know the real delivery result you must either:

- Poll `GET /api/v1/messages/status/:messageId`, or
- Receive the status via your configured webhook.

**Status lifecycle:**

```
queued  →  sending  →  sent  →  delivered  →  read
```

Special / edge states:

| Status             | Meaning                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `sent_uncertain` | Puppeteer frame crashed mid-send; the message may still have been delivered. Awaiting ACK confirmation. |
| `failed`         | Send failed.`error_message` explains why.                                                             |

**ACK levels:** `0` = pending/clock · `1` = sent (✓) · `2` = delivered (✓✓) · `3` = read (✓✓ blue) · `-1` = error.

---

## Recipients & formatting

- **`to`** is the recipient. Phone numbers should be in international format **without** the `+` (e.g. `201001234567`).
- Non-digit characters are stripped and `@c.us` is appended automatically.
- Groups: pass the full `<id>@g.us`.
- A recipient is valid if its digit count is ≥ 10 (or it ends in `@g.us`).

### Spintax

Text `message` and media `caption` support spintax `{option1|option2|option3}`. On each send a single variation is resolved, which helps vary content (anti-ban).

---

## Endpoints overview

| #  | Method | Path                            | Purpose                         |
| -- | ------ | ------------------------------- | ------------------------------- |
| 1  | POST   | `/messages/send-text`         | Text message                    |
| 2  | POST   | `/messages/send-media`        | Media by URL (auto-detect type) |
| 3  | POST   | `/messages/send-image`        | Image                           |
| 4  | POST   | `/messages/send-document`     | Document                        |
| 5  | POST   | `/messages/send-video`        | Video                           |
| 6  | POST   | `/messages/send-audio`        | Audio / voice note              |
| 7  | POST   | `/messages/send-location`     | Location                        |
| 8  | GET    | `/messages/status/:messageId` | Query message status            |
| 9  | GET    | `/device/info`                | Device details                  |
| 10 | GET    | `/health`                     | Health check                    |

> **Not supported:** contact/vCard, buttons, list, poll, sticker, reaction sending. Only the 7 send types above exist (buttons/lists were deprecated by WhatsApp).

Every send response returns a `messageId` (the queue entry ID) and `status: "queued"`. Use that `messageId` with endpoint #8 to track delivery.

---

## 1. Send Text — `POST /messages/send-text`

**Body**

| Field              | Type    | Required | Notes                                    |
| ------------------ | ------- | -------- | ---------------------------------------- |
| `to`             | string  | ✅       | Recipient number or`<id>@g.us`         |
| `message`        | string  | ✅       | Supports spintax `{a                     |
| `simulateTyping` | boolean | ❌       | Typing simulation before send (anti-ban) |

**Example**

```bash
curl -X POST https://your-host/api/v1/messages/send-text \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "201001234567",
    "message": "Hello {there|friend}! 👋"
  }'
```

**Response**

```json
{
  "success": true,
  "mode": "single",
  "messageId": "12345",
  "to": "201001234567",
  "status": "queued",
  "message": "Message queued for delivery"
}
```

---

## 2. Send Media — `POST /messages/send-media`

Generic media endpoint. The server downloads the file from `mediaUrl` (axios, 60s timeout, 50 MB max), converts to base64, and queues it for send.

**Body**

| Field               | Type    | Required | Notes                                                                                                       |
| ------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `to`              | string  | ✅       | Recipient                                                                                                   |
| `mediaUrl`        | string  | ✅       | HTTP(S) URL of the file                                                                                     |
| `caption`         | string  | ❌       | Supports spintax                                                                                            |
| `mediaType`       | string  | ❌       | `image` \| `video` \| `document` \| `audio`. Auto-detected from Content-Type / extension if omitted |
| `filename`        | string  | ❌       | For documents; derived from URL if omitted                                                                  |
| `sendAsVoiceNote` | boolean | ❌       | Audio → PTT voice note                                                                                     |
| `sendAsDocument`  | boolean | ❌       | Force send as document                                                                                      |

**Example**

```bash
curl -X POST https://your-host/api/v1/messages/send-media \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "201001234567",
    "mediaUrl": "https://example.com/photo.jpg",
    "caption": "Check this out"
  }'
```

**Response**

```json
{
  "success": true,
  "mode": "single",
  "messageId": "12346",
  "to": "201001234567",
  "status": "queued",
  "mediaType": "image"
}
```

---

## 3. Send Image — `POST /messages/send-image`

Thin wrapper over send-media, forces `mediaType = image`.

| Field                              | Type   | Required | Notes            |
| ---------------------------------- | ------ | -------- | ---------------- |
| `to`                             | string | ✅       | Recipient        |
| `imageUrl` *(or `mediaUrl`)* | string | ✅       | Image URL        |
| `caption`                        | string | ❌       | Supports spintax |

```bash
curl -X POST https://your-host/api/v1/messages/send-image \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "201001234567", "imageUrl": "https://example.com/photo.jpg", "caption": "Hi" }'
```

---

## 4. Send Document — `POST /messages/send-document`

Forces `mediaType = document`.

| Field                                 | Type   | Required | Notes            |
| ------------------------------------- | ------ | -------- | ---------------- |
| `to`                                | string | ✅       | Recipient        |
| `documentUrl` *(or `mediaUrl`)* | string | ✅       | Document URL     |
| `filename`                          | string | ❌       | Display filename |

```bash
curl -X POST https://your-host/api/v1/messages/send-document \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "201001234567", "documentUrl": "https://example.com/invoice.pdf", "filename": "Invoice.pdf" }'
```

---

## 5. Send Video — `POST /messages/send-video`

Forces `mediaType = video`.

| Field                              | Type   | Required | Notes            |
| ---------------------------------- | ------ | -------- | ---------------- |
| `to`                             | string | ✅       | Recipient        |
| `videoUrl` *(or `mediaUrl`)* | string | ✅       | Video URL        |
| `caption`                        | string | ❌       | Supports spintax |

```bash
curl -X POST https://your-host/api/v1/messages/send-video \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "201001234567", "videoUrl": "https://example.com/clip.mp4", "caption": "Watch" }'
```

---

## 6. Send Audio — `POST /messages/send-audio`

Forces `mediaType = audio`.

| Field                              | Type    | Required | Notes                  |
| ---------------------------------- | ------- | -------- | ---------------------- |
| `to`                             | string  | ✅       | Recipient              |
| `audioUrl` *(or `mediaUrl`)* | string  | ✅       | Audio URL              |
| `sendAsVoiceNote`                | boolean | ❌       | Send as PTT voice note |

```bash
curl -X POST https://your-host/api/v1/messages/send-audio \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "201001234567", "audioUrl": "https://example.com/voice.mp3", "sendAsVoiceNote": true }'
```

---

## 7. Send Location — `POST /messages/send-location`

| Field                             | Type   | Required | Notes          |
| --------------------------------- | ------ | -------- | -------------- |
| `to`                            | string | ✅       | Recipient      |
| `latitude`                      | number | ✅       |                |
| `longitude`                     | number | ✅       |                |
| `name` *(or `description`)* | string | ❌       | Location label |
| `address`                       | string | ❌       | Address text   |

```bash
curl -X POST https://your-host/api/v1/messages/send-location \
  -H "Authorization: Bearer wa_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "201001234567", "latitude": 30.0444, "longitude": 31.2357, "name": "Cairo Office" }'
```

---

## 8. Message Status — `GET /messages/status/:messageId`

`:messageId` = the queue entry ID returned by a send call. This is how you resolve the real outcome of the async send.

```bash
curl https://your-host/api/v1/messages/status/12345 \
  -H "Authorization: Bearer wa_xxxxxxxx"
```

**Response**

```json
{
  "success": true,
  "message": {
    "id": 12345,
    "status": "delivered",
    "recipient": "201001234567",
    "whatsapp_message_id": "3EB0XXXXXXXX",
    "ack_level": 2,
    "sent_at": "2026-08-08T12:00:00.000Z",
    "delivered_at": "2026-08-08T12:00:03.000Z",
    "read_at": null,
    "error_message": null
  }
}
```

---

## 9. Device Info — `GET /device/info`

Returns the authenticated device: `id`, `device_name`, `phone_number`, `status`, `trust_level`, `timezone`, etc.

---

## 10. Health — `GET /health`

```json
{ "success": true, "status": "ok", "device": { "id": 230, "device_name": "..." }, "timestamp": "..." }
```

---

## Error responses

All errors follow:

```json
{ "success": false, "error": "<description>" }
```

Common codes: `400` (validation / missing field), `401` (auth), `404` (unknown messageId), `500` (server/send error).

[![WhatsDeveloper](/logo.png)

WhatsDeveloper API Documentation

](/)

Getting Started

* [Overview](#overview)
* [Authentication](#authentication)
* [Base URL](#base-url)

Labels Management

* [Labels Overview NEW](#labels-overview)
* [Get All Labels](#get-labels)
* [Get Label by ID](#get-label-by-id)
* [Get Chats by Label](#get-chats-by-label)
* [Get Chat Labels](#get-chat-labels)
* [Assign Labels](#assign-labels)
* [Remove Labels](#remove-labels)
* [Replace Labels](#replace-labels)

Messaging APIs

* [Send Messages](#messaging)
* [Webhooks](#webhooks)
* [Use Cases](#use-cases)

Reference

* [Error Codes](#errors)
* [Best Practices](#best-practices)

Ready to get started? Create your free account now.

[Get Started Free](/register)

WhatsDeveloper API Documentation
================================

Complete REST API reference for managing WhatsApp Business labels, sending messages, and building powerful automation workflows. Organize your contacts, track customer journeys, and scale your WhatsApp operations.

API Version 1.0 · Last Updated Feb 2026

Overview
--------

The WhatsDeveloper API provides a comprehensive RESTful interface for managing your WhatsApp Business operations. With 15+ endpoints, you can send all message types, manage contact labels, configure webhooks, run campaigns, and monitor delivery in real time.

#### Labels Management

Full CRUD operations for WhatsApp Business labels. Organize contacts, track customer stages, and automate classification.

#### Multi-Type Messaging

Send text, images, documents, audio, video, locations, and contact cards through a unified API interface.

#### Smart Webhooks

Receive real-time notifications for incoming messages, unread messages, and read-no-reply events.

#### Campaign Engine

Bulk messaging with smart batching, Spintax support, trust-based rate limiting, and delivery tracking.

Authentication
--------------

All API requests require authentication using your unique UUID and API Token. These credentials are available in your dashboard after connecting a WhatsApp device.

### Required Headers

Content-Type: application/json
x-device-uuid: your-device-uuid-here
x-api-token: your-api-token-here

**Where to find your credentials**

Navigate to your dashboard, go to WhatsApp Profiles, and click on the device you want to use. Your UUID and API Token are displayed in the device settings panel.

Base URL
--------

All API endpoints are relative to the following base URL:

https://whatsdeveloper.com/api/v1

This is the base URL for all API requests to the WhatsDeveloper platform.

WhatsApp Business Labels Management
-----------------------------------

Labels are a powerful feature of WhatsApp Business that allow you to organize and categorize your chats and contacts. With WhatsDeveloper's Labels API, you can programmatically manage labels to build sophisticated customer relationship workflows, automate contact classification, and create targeted messaging campaigns.

### What Are WhatsApp Business Labels?

WhatsApp Business labels are color-coded tags that you can assign to chats to organize your conversations. They function similarly to tags or categories in a CRM system, enabling you to segment your audience and track customer journeys through different stages of your sales or support pipeline.

### Why Use Labels via API?

* **Automated Classification:** Automatically tag new customers, leads, or support tickets based on incoming message content or external triggers.
* **CRM Integration:** Sync label assignments with your existing CRM to maintain a unified view of customer stages across platforms.
* **Targeted Campaigns:** Fetch all contacts under a specific label and send targeted bulk messages only to that segment.
* **Customer Lifecycle Tracking:** Move contacts through stages (Lead, Interested, Buyer, VIP) automatically as they interact with your business.
* **Analytics & Reporting:** Build dashboards that show customer distribution across labels, conversion rates between stages, and more.

### Labels API Endpoints Summary

Method

Endpoint

Description

GET

`/api/v1/labels`

Retrieve all available labels

GET

`/api/v1/labels/{labelId}`

Get a specific label by ID

GET

`/api/v1/labels/{labelId}/chats`

Get all chats assigned to a label

GET

`/api/v1/chat/{phone}/labels`

Get all labels assigned to a chat

POST

`/api/v1/labels/assign`

Assign labels to one or more chats

POST

`/api/v1/labels/remove`

Remove labels from chats

PUT

`/api/v1/chat/{phone}/labels`

Replace all labels on a chat

GET Get All Labels
------------------

Retrieve a list of all WhatsApp Business labels configured on your device. Each label includes its unique ID, display name, and hex color code.

GET /api/v1/labels

#### Response Example

{
  "success": true,
  "labels": \[
    { "id": "1", "name": "New Customer", "hexColor": "#64c4ff" },
    { "id": "2", "name": "VIP", "hexColor": "#ffd429" },
    { "id": "3", "name": "Pending Payment", "hexColor": "#ff9a2c" },
    { "id": "4", "name": "Completed", "hexColor": "#25d366" }
  \],
  "count": 4
}

#### Response Fields

Field

Type

Description

`success`

boolean

Whether the request was successful

`labels`

array

Array of label objects

`labels[].id`

string

Unique label identifier

`labels[].name`

string

Display name of the label

`labels[].hexColor`

string

Hex color code for the label

`count`

number

Total number of labels

GET Get Label by ID
-------------------

Retrieve detailed information about a specific label using its unique identifier.

GET /api/v1/labels/{labelId}

#### Path Parameters

Parameter

Type

Required

Description

`labelId`

string

Required

The unique identifier of the label

#### Response Example

{
  "success": true,
  "label": {
    "id": "1",
    "name": "New Customer",
    "hexColor": "#64c4ff"
  }
}

GET Get Chats by Label
----------------------

Retrieve all chats (conversations) that have been assigned a specific label. This is essential for building targeted campaigns or generating reports on customer segments.

GET /api/v1/labels/{labelId}/chats

#### Response Example

{
  "success": true,
  "labelId": "1",
  "labelName": "New Customer",
  "chats": \[
    {
      "id": "201234567890@c.us",
      "name": "Ahmed Mohamed",
      "isGroup": false,
      "unreadCount": 2,
      "timestamp": 1708387200,
      "lastMessage": {
        "body": "Hello, I'm interested in your product",
        "timestamp": 1708387200,
        "fromMe": false
      }
    }
  \],
  "count": 1
}

**Pro Tip: Targeted Campaigns**

Use this endpoint to fetch all contacts under a label like "Interested Leads", then pass their phone numbers to the bulk messaging API for a highly targeted campaign with better conversion rates.

GET Get Chat Labels
-------------------

Retrieve all labels currently assigned to a specific chat (contact). Useful for checking a customer's current classification before making updates.

GET /api/v1/chat/{phoneNumber}/labels

#### Path Parameters

Parameter

Type

Required

Description

`phoneNumber`

string

Required

Phone number (e.g., 201234567890) without + prefix

#### Response Example

{
  "success": true,
  "chatId": "201234567890@c.us",
  "labels": \[
    { "id": "1", "name": "New Customer", "hexColor": "#64c4ff" },
    { "id": "2", "name": "VIP", "hexColor": "#ffd429" }
  \],
  "count": 2
}

POST Assign Labels to Chats
---------------------------

Assign one or more labels to one or more chats simultaneously. This is an additive operation; existing labels on the chats will be preserved, and the specified labels will be added.

POST /api/v1/labels/assign

#### Request Body

{
  "labelIds": \["1", "2"\],
  "chatIds": \["201234567890", "201098765432"\]
}

Field

Type

Required

Description

`labelIds`

array

Required

Array of label IDs to assign

`chatIds`

array

Required

Array of phone numbers or chat IDs to label

#### Response Example

{
  "success": true,
  "message": "Labels assigned successfully to 2 chat(s)",
  "labelIds": \["1", "2"\],
  "chatIds": \["201234567890@c.us", "201098765432@c.us"\]
}

**Automation Example**

When a new message arrives via webhook, analyze the content with AI (e.g., OpenAI) and automatically assign relevant labels like "Support Request", "Sales Inquiry", or "Complaint" based on the message intent.

POST Remove Labels from Chats
-----------------------------

Remove specific labels from one or more chats. Only the specified labels will be removed; other labels on the chats will remain unchanged.

POST /api/v1/labels/remove

#### Request Body

{
  "labelIds": \["1"\],
  "chatIds": \["201234567890"\]
}

Field

Type

Required

Description

`labelIds`

array

Required

Array of label IDs to remove

`chatIds`

array

Required

Array of phone numbers or chat IDs

#### Response Example

{
  "success": true,
  "message": "Labels removed successfully from 1 chat(s)",
  "removedLabelIds": \["1"\],
  "chatIds": \["201234567890@c.us"\]
}

PUT Replace All Chat Labels
---------------------------

Replace all existing labels on a specific chat with a new set of labels. This is a destructive operation; all current labels will be removed and replaced with the specified ones. Send an empty array to remove all labels from a chat.

PUT /api/v1/chat/{phoneNumber}/labels

#### Request Body

{
  "labelIds": \["3", "4"\]
}

Field

Type

Required

Description

`labelIds`

array

Required

Array of new label IDs. Replaces all current labels. Send `[]` to clear all labels.

#### Response Example

{
  "success": true,
  "message": "Labels updated for chat 201234567890@c.us",
  "chatId": "201234567890@c.us",
  "newLabelIds": \["3", "4"\]
}

**Caution: Destructive Operation**

This endpoint replaces all existing labels. If a chat has labels "New Customer" and "VIP", and you PUT with only "Buyer", the chat will lose "New Customer" and "VIP" labels. Use the assign/remove endpoints for non-destructive operations.

Messaging APIs
--------------

WhatsDeveloper supports sending all WhatsApp message types through a unified REST API. Each message type has its own dedicated endpoint with specific parameters.

Method

Endpoint

Description

POST

`/api/v1/messages/send-text`

Send a text message with optional Spintax

POST

`/api/v1/messages/send-image`

Send an image with optional caption

POST

`/api/v1/messages/send-document`

Send a document (PDF, DOCX, etc.)

POST

`/api/v1/messages/send-audio`

Send audio or voice note (PTT)

POST

`/api/v1/messages/send-video`

Send a video with optional caption

POST

`/api/v1/messages/send-location`

Send a location pin with coordinates

POST

`/api/v1/messages/send-contact`

Send a contact card (vCard)

GET

`/api/v1/check-number/{phone}`

Check if a number is on WhatsApp

GET

`/api/v1/device/status`

Get device connection status

### Send Text Message Example

POST /api/v1/messages/send-text

{
  "to": "201234567890",
  "message": "{Hello|Hi|Hey}! Thank you for contacting us."
}

**Spintax Support**

Use `{option1|option2|option3}` syntax in your messages to create unique variations for each recipient. This helps avoid spam detection when sending bulk messages.

Webhook Notifications
---------------------

WhatsDeveloper supports four types of real-time webhook notifications that you can configure per device. These webhooks enable you to build powerful automation workflows with tools like n8n, Zapier, or custom backends.

Webhook Type

Trigger

Use Case

**Incoming Messages**

New message received

Chatbots, auto-replies, CRM logging

**Unread Messages**

Message unread after X minutes

Follow-up reminders, escalation alerts

**Read No-Reply**

Message read but no reply after X minutes

Re-engagement campaigns, lead nurturing

**Status Updates**

Message delivery status changes

Delivery tracking, analytics dashboards

### Incoming Message Webhook Payload

{
  "type": "incoming\_message",
  "from": "201234567890",
  "from\_name": "Customer Name",
  "body": "Hello, I need help with my order",
  "timestamp": "2026-02-21T10:30:00Z",
  "is\_group": false,
  "device\_id": 1
}

### WhatsApp `@lid` contacts

WhatsApp sometimes sends a contact as a Local Identifier instead of a phone JID.
An `@lid` value is **not a phone number** and must not be converted by simply
removing `@lid`.

The webhook bridge resolves `key.remoteJidAlt` (or Baileys' LID mapping) before
forwarding the event. Use these fields in n8n:

| Field | Meaning |
| --- | --- |
| `data.from` | Phone number without suffix when resolved; otherwise the full `@lid` JID |
| `data.fromPhone` | Resolved phone number, or an empty string when no mapping is available |
| `data.replyTo` | Safe recipient for the send endpoint: phone JID when resolved, full `@lid` JID otherwise |
| `data.fromJid` | Full resolved sender JID, or the original `@lid` JID |
| `data.fromLid` | Original `@lid` value when the event used LID addressing |

For replies, send `data.replyTo` to `POST /api/send-message` (or the equivalent
n8n send node). The Evolution API accepts a full `@lid` JID, so a reply does not
need to wait for a phone-number mapping.

Labels Management Use Cases
---------------------------

Here are practical scenarios showing how to leverage the Labels API to build powerful WhatsApp Business workflows.

1

#### E-Commerce Order Tracking

Automatically label customers as "New Order", "Shipped", "Delivered" based on order status changes from your store. Use webhooks to trigger label updates when order status changes in Shopify or WooCommerce.

2

#### AI-Powered Lead Scoring

Analyze incoming messages with AI to detect purchase intent. Automatically assign "Hot Lead", "Warm Lead", or "Cold Lead" labels. Send targeted follow-up campaigns to hot leads within minutes.

3

#### Support Ticket Management

Label incoming support requests as "Open Ticket". When resolved, replace with "Resolved". Generate weekly reports on ticket volume and resolution rates by querying label-based chat counts.

4

#### Customer Lifecycle Automation

Build a complete customer journey: Prospect, Interested, Buyer, Repeat Customer, VIP. Use the PUT endpoint to move customers through stages automatically based on their interactions and purchase history.

5

#### Appointment Reminders

Label contacts as "Appointment Scheduled" when they book. Use a scheduled job to fetch all contacts with this label and send reminder messages 24 hours before their appointment.

6

#### Multi-Language Segmentation

Detect the language of incoming messages and assign labels like "Arabic", "English", "French". Send marketing campaigns in the correct language to each segment for higher engagement.

Error Codes
-----------

The API uses standard HTTP status codes to indicate success or failure. All error responses include a JSON body with a descriptive message.

Status Code

Meaning

Common Cause

`200`

Success

Request completed successfully

`400`

Bad Request

Missing or invalid parameters

`401`

Unauthorized

Invalid or missing API credentials

`404`

Not Found

Label, chat, or resource not found

`429`

Rate Limited

Too many requests; respect rate limits

`500`

Server Error

Internal error; contact support

#### Error Response Format

{
  "success": false,
  "error": "Label not found",
  "code": 404
}

Best Practices
--------------

**Keep Your Device Connected**

Maintain a stable WhatsApp connection to build trust level and unlock higher messaging limits. Disconnecting resets your trust level to 1.

**Use Spintax for Bulk Messages**

Always use Spintax variations in bulk campaigns to create unique messages for each recipient. This significantly reduces the risk of spam detection by WhatsApp.

**Validate Numbers Before Sending**

Use the check-number endpoint to verify that phone numbers are registered on WhatsApp before sending messages. This reduces failure rates and improves campaign performance.

**Organize with Labels**

Establish a consistent labeling strategy across your team. Define clear label names and colors for each customer stage, and use automation to maintain label accuracy.

**Monitor API Logs**

Regularly check your API logs dashboard to track delivery rates, identify failed messages, and optimize your messaging strategy based on real performance data.

© 2026 WhatsDeveloper. All rights reserved. · [Back to Home](/) · [Get Started Free](/register)
