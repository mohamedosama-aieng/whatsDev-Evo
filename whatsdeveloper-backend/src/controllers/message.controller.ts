import { Request, Response } from 'express';
import { EvolutionService } from '../services/evolution.service';
import { AuthedRequest } from '../middleware/auth.middleware';

export class MessageController {
  constructor(private evolutionService: EvolutionService) {}

  /**
   * Which profile to send as, and the key to authenticate with.
   *
   * Set by the auth middleware from the caller's token. Every send below must
   * pass both to EvolutionService; omitting them is what made two profiles both
   * send from DEFAULT_INSTANCE_NAME. The service's own `instanceName ||
   * this.defaultInstance` fallback hides the mistake, so it will not surface as
   * an error - only as messages leaving the wrong account.
   */
  private target(req: Request): { instance: string | undefined; key: string | undefined } {
    const areq = req as AuthedRequest;
    return { instance: areq.instanceName, key: areq.instanceKey };
  }

  /**
   * @swagger
   * /api/send-message:
   *   post:
   *     summary: Send text message
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - message
   *             properties:
   *               phone:
   *                 type: string
   *                 example: "201234567890"
   *               message:
   *                 type: string
   *                 example: "Hello from WhatsDeveloper"
   *     responses:
   *       200:
   *         description: Message sent successfully
   */
  async sendMessage(req: Request, res: Response) {
    try {
      // Support both 'phone' and 'to' parameters (n8n compatibility)
      const phone = req.body.phone || req.body.to;
      const message = req.body.message;

      if (!phone || !message) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone/to, message',
        });
      }

      const { instance, key } = this.target(req);

      // ✅ Respond immediately to n8n
      res.json({
        success: true,
        status: 'queued',
        message: 'Message queued for sending',
        data: {
          phone,
          type: 'text',
          // Echo the resolved profile: the send happens after this response, so
          // this is the only way a caller can tell which account was used.
          instance,
        },
      });

      // 🚀 Send message in background (don't await)
      this.evolutionService.sendText(phone, message, instance, key).catch((error) => {
        console.error(`[sendMessage] Background send failed (instance=${instance}):`, error.message);
      });

    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to queue message',
      });
    }
  }

  /**
   * Alias for sendMessage - n8n compatibility
   * POST /api/v1/messages/send-text
   */
  async sendText(req: Request, res: Response) {
    return this.sendMessage(req, res);
  }

  /**
   * @swagger
   * /api/send-image:
   *   post:
   *     summary: Send image message
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - image
   *             properties:
   *               phone:
   *                 type: string
   *               image:
   *                 type: string
   *                 description: Image URL
   *               caption:
   *                 type: string
   *     responses:
   *       200:
   *         description: Image sent successfully
   */
  async sendImage(req: Request, res: Response) {
    try {
      // Support both 'phone'/'to' and 'image'/'imageUrl' (n8n compatibility)
      const phone = req.body.phone || req.body.to;
      const image = req.body.image || req.body.imageUrl;
      const caption = req.body.caption;
      const { instance, key } = this.target(req);

      if (!phone || !image) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone/to, image/imageUrl',
        });
      }

      // ✅ Respond immediately to n8n
      res.json({
        success: true,
        status: 'queued',
        message: 'Image queued for sending',
        data: {
          phone,
          type: 'image',
          image,
        },
      });

      // 🚀 Send image in background
      this.evolutionService.sendImage(phone, image, caption, instance, key).catch((error) => {
        console.error('[sendImage] Background send failed:', error.message);
      });

    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to queue image',
      });
    }
  }

  /**
   * @swagger
   * /api/send-video:
   *   post:
   *     summary: Send video message
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - video
   *             properties:
   *               phone:
   *                 type: string
   *               video:
   *                 type: string
   *               caption:
   *                 type: string
   *     responses:
   *       200:
   *         description: Video sent successfully
   */
  async sendVideo(req: Request, res: Response) {
    try {
      // Support both 'phone'/'to' and 'video'/'videoUrl' (n8n compatibility)
      const phone = req.body.phone || req.body.to;
      const video = req.body.video || req.body.videoUrl;
      const caption = req.body.caption;
      const { instance, key } = this.target(req);

      if (!phone || !video) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone/to, video/videoUrl',
        });
      }

      // ✅ Respond immediately to n8n
      res.json({
        success: true,
        status: 'queued',
        message: 'Video queued for sending',
        data: {
          phone,
          type: 'video',
          video,
        },
      });

      // 🚀 Send video in background
      this.evolutionService.sendVideo(phone, video, caption, instance, key).catch((error) => {
        console.error('[sendVideo] Background send failed:', error.message);
      });

    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to queue video',
      });
    }
  }

  /**
   * @swagger
   * /api/send-audio:
   *   post:
   *     summary: Send audio message
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - audio
   *             properties:
   *               phone:
   *                 type: string
   *               audio:
   *                 type: string
   *     responses:
   *       200:
   *         description: Audio sent successfully
   */
  async sendAudio(req: Request, res: Response) {
    try {
      // Support both 'phone'/'to' and 'audio'/'audioUrl' (n8n compatibility)
      const phone = req.body.phone || req.body.to;
      const audio = req.body.audio || req.body.audioUrl;
      const ptt = req.body.ptt; // PTT support for voice messages
      const { instance, key } = this.target(req);

      if (!phone || !audio) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone/to, audio/audioUrl',
        });
      }

      // ✅ Respond immediately to n8n
      res.json({
        success: true,
        status: 'queued',
        message: 'Audio queued for sending',
        data: {
          phone,
          type: 'audio',
          audio,
          ptt,
        },
      });

      // 🚀 Send audio in background
      this.evolutionService.sendAudio(phone, audio, ptt, instance, key).catch((error) => {
        console.error('[sendAudio] Background send failed:', error.message);
      });

    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to queue audio',
      });
    }
  }

  /**
   * @swagger
   * /api/send-document:
   *   post:
   *     summary: Send document
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - document
   *             properties:
   *               phone:
   *                 type: string
   *               document:
   *                 type: string
   *               fileName:
   *                 type: string
   *     responses:
   *       200:
   *         description: Document sent successfully
   */
  async sendDocument(req: Request, res: Response) {
    try {
      // Support both 'phone'/'to' and 'document'/'documentUrl' (n8n compatibility)
      const phone = req.body.phone || req.body.to;
      const document = req.body.document || req.body.documentUrl;
      const fileName = req.body.fileName || req.body.filename;
      const { instance, key } = this.target(req);

      if (!phone || !document) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone/to, document/documentUrl',
        });
      }

      // ✅ Respond immediately to n8n
      res.json({
        success: true,
        status: 'queued',
        message: 'Document queued for sending',
        data: {
          phone,
          type: 'document',
          document,
          fileName,
        },
      });

      // 🚀 Send document in background
      this.evolutionService.sendDocument(phone, document, fileName, instance, key).catch((error) => {
        console.error('[sendDocument] Background send failed:', error.message);
      });

    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to queue document',
      });
    }
  }

  /**
   * @swagger
   * /api/send-location:
   *   post:
   *     summary: Send location
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - latitude
   *               - longitude
   *             properties:
   *               phone:
   *                 type: string
   *               latitude:
   *                 type: number
   *               longitude:
   *                 type: number
   *               name:
   *                 type: string
   *               address:
   *                 type: string
   *     responses:
   *       200:
   *         description: Location sent successfully
   */
  async sendLocation(req: Request, res: Response) {
    try {
      const { phone, latitude, longitude, name, address } = req.body;

      if (!phone || latitude === undefined || longitude === undefined) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone, latitude, longitude',
        });
      }

      const { instance, key } = this.target(req);
      const result = await this.evolutionService.sendLocation(
        phone,
        latitude,
        longitude,
        name,
        address,
        instance,
        key,
      );

      return res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to send location',
      });
    }
  }

  /**
   * @swagger
   * /api/send-contact:
   *   post:
   *     summary: Send contact
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - contactPhone
   *               - contactName
   *             properties:
   *               phone:
   *                 type: string
   *               contactPhone:
   *                 type: string
   *               contactName:
   *                 type: string
   *     responses:
   *       200:
   *         description: Contact sent successfully
   */
  async sendContact(req: Request, res: Response) {
    try {
      const { phone, contactPhone, contactName } = req.body;

      if (!phone || !contactPhone || !contactName) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone, contactPhone, contactName',
        });
      }

      const { instance, key } = this.target(req);
      const result = await this.evolutionService.sendContact(phone, contactPhone, contactName, instance, key);

      return res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to send contact',
      });
    }
  }

  /**
   * @swagger
   * /api/send-buttons:
   *   post:
   *     summary: Send buttons message
   *     tags: [Messages]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - phone
   *               - title
   *               - description
   *               - buttons
   *             properties:
   *               phone:
   *                 type: string
   *               title:
   *                 type: string
   *               description:
   *                 type: string
   *               buttons:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Buttons sent successfully
   */
  async sendButtons(req: Request, res: Response) {
    try {
      const { phone, title, description, buttons } = req.body;

      if (!phone || !title || !description || !buttons || !Array.isArray(buttons)) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: phone, title, description, buttons (array)',
        });
      }

      const { instance, key } = this.target(req);
      const result = await this.evolutionService.sendButtons(phone, title, description, buttons, instance, key);

      return res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to send buttons',
      });
    }
  }
}
