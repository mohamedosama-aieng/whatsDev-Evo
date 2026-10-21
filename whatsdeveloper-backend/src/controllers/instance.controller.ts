import { Request, Response } from 'express';
import { EvolutionService } from '../services/evolution.service';
import { AuthedRequest } from '../middleware/auth.middleware';

export class InstanceController {
  constructor(private evolutionService: EvolutionService) {}

  /**
   * Which profile this request is scoped to, and the key to authenticate with.
   *
   * Same contract as MessageController.target(): the auth middleware resolved
   * the caller's token, and these must be forwarded to EvolutionService. Reading
   * status/chats without them reported the default instance no matter which
   * token was sent - that is how "both profiles look identical" showed up on the
   * read endpoints too, not just on send.
   */
  private target(req: Request): { instance: string | undefined; key: string | undefined } {
    const areq = req as AuthedRequest;
    return { instance: areq.instanceName, key: areq.instanceKey };
  }

  /**
   * @swagger
   * /api/instance/status:
   *   get:
   *     summary: Get instance connection status
   *     tags: [Instance]
   *     responses:
   *       200:
   *         description: Instance status retrieved
   */
  async getStatus(req: Request, res: Response) {
    try {
      const { instance, key } = this.target(req);
      const result = await this.evolutionService.getInstanceStatus(instance, key);

      return res.json({
        success: true,
        instance,
        data: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get instance status',
      });
    }
  }

  /**
   * @swagger
   * /api/chats:
   *   get:
   *     summary: Get all chats
   *     tags: [Chats]
   *     responses:
   *       200:
   *         description: Chats retrieved successfully
   */
  async getChats(req: Request, res: Response) {
    try {
      const { instance, key } = this.target(req);
      const result = await this.evolutionService.getChats(instance, key);

      return res.json({
        success: true,
        instance,
        data: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get chats',
      });
    }
  }

  /**
   * @swagger
   * /api/messages/{phone}:
   *   get:
   *     summary: Get messages for a specific chat
   *     tags: [Chats]
   *     parameters:
   *       - in: path
   *         name: phone
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 50
   *     responses:
   *       200:
   *         description: Messages retrieved successfully
   */
  async getMessages(req: Request, res: Response) {
    try {
      const { phone } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;

      if (!phone) {
        return res.status(400).json({
          success: false,
          error: 'Phone number is required',
        });
      }

      const { instance, key } = this.target(req);
      const result = await this.evolutionService.getChatMessages(phone, limit, instance, key);

      return res.json({
        success: true,
        instance,
        data: result,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get messages',
      });
    }
  }
}
