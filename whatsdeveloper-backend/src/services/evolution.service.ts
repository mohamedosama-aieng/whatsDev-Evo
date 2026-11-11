import axios from 'axios';

export interface EvolutionConfig {
  baseURL: string;
  apiKey: string;
  defaultInstance: string;
  mediaTimeoutMs?: number;
}

export class EvolutionService {
  private baseURL: string;
  private apiKey: string;
  private defaultInstance: string;
  private mediaTimeoutMs: number;

  constructor(config: EvolutionConfig) {
    this.baseURL = config.baseURL;
    this.apiKey = config.apiKey;
    this.defaultInstance = config.defaultInstance;
    this.mediaTimeoutMs =
      Number.isFinite(config.mediaTimeoutMs) && config.mediaTimeoutMs! > 0 ? config.mediaTimeoutMs! : 120000;
  }

  /**
   * Create axios client with specific API key
   */
  private getClient(apiKeyOverride?: string, timeout = 30000) {
    return axios.create({
      baseURL: this.baseURL,
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKeyOverride || this.apiKey,
      },
      timeout,
    });
  }

  /**
   * Send text message
   */
  async sendText(phone: string, message: string, instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/message/sendText/${instance}`, {
      number: phone,
      text: message,
    });
    return response.data;
  }

  /**
   * Send image with caption
   */
  async sendImage(phone: string, imageUrl: string, caption?: string, instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride, this.mediaTimeoutMs);
    const response = await client.post(`/message/sendMedia/${instance}`, {
      number: phone,
      mediatype: 'image',
      media: imageUrl,
      caption: caption || '',
    });
    return response.data;
  }

  /**
   * Send video with caption
   */
  async sendVideo(phone: string, videoUrl: string, caption?: string, instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride, this.mediaTimeoutMs);
    const response = await client.post(`/message/sendMedia/${instance}`, {
      number: phone,
      mediatype: 'video',
      media: videoUrl,
      caption: caption || '',
    });
    return response.data;
  }

  /**
   * Send audio (with PTT support)
   */
  async sendAudio(phone: string, audioUrl: string, ptt?: boolean, instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/message/sendWhatsAppAudio/${instance}`, {
      number: phone,
      audio: audioUrl,
      ptt: ptt !== undefined ? ptt : true, // Default to PTT if not specified
    });
    return response.data;
  }

  /**
   * Send document
   */
  async sendDocument(
    phone: string,
    documentUrl: string,
    fileName?: string,
    instanceName?: string,
    apiKeyOverride?: string,
  ) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride, this.mediaTimeoutMs);
    const response = await client.post(`/message/sendMedia/${instance}`, {
      number: phone,
      mediatype: 'document',
      media: documentUrl,
      fileName: fileName || 'document.pdf',
    });
    return response.data;
  }

  /**
   * Send location
   */
  async sendLocation(
    phone: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    instanceName?: string,
    apiKeyOverride?: string,
  ) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/message/sendLocation/${instance}`, {
      number: phone,
      latitude,
      longitude,
      name: name || 'Location',
      address: address || '',
    });
    return response.data;
  }

  /**
   * Send contact
   */
  async sendContact(
    phone: string,
    contactPhone: string,
    contactName: string,
    instanceName?: string,
    apiKeyOverride?: string,
  ) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/message/sendContact/${instance}`, {
      number: phone,
      contact: [
        {
          fullName: contactName,
          wuid: contactPhone,
          phoneNumber: contactPhone,
        },
      ],
    });
    return response.data;
  }

  /**
   * Send buttons (list message)
   */
  async sendButtons(
    phone: string,
    title: string,
    description: string,
    buttons: string[],
    instanceName?: string,
    apiKeyOverride?: string,
  ) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);

    // Evolution API uses list message format
    const sections = [
      {
        title: 'Options',
        rows: buttons.map((btn, idx) => ({
          title: btn,
          description: '',
          rowId: `option_${idx}`,
        })),
      },
    ];

    const response = await client.post(`/message/sendList/${instance}`, {
      number: phone,
      title,
      description,
      buttonText: 'View Options',
      sections,
    });
    return response.data;
  }

  /**
   * Get instance connection status
   */
  async getInstanceStatus(instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.get(`/instance/connectionState/${instance}`);
    return response.data;
  }

  /**
   * Get chat messages
   */
  async getChatMessages(phone: string, limit = 50, instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/chat/findMessages/${instance}`, {
      where: {
        key: {
          remoteJid: phone.includes('@') ? phone : `${phone}@s.whatsapp.net`,
        },
      },
      limit,
    });
    return response.data;
  }

  /**
   * Get all chats
   */
  async getChats(instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/chat/findChats/${instance}`, {
      where: {},
    });
    return response.data;
  }

  /**
   * Send media from base64
   */
  async sendMediaBase64(
    phone: string,
    base64: string,
    mediaType: string,
    caption?: string,
    instanceName?: string,
    apiKeyOverride?: string,
  ) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride, this.mediaTimeoutMs);
    const response = await client.post(`/message/sendMedia/${instance}`, {
      number: phone,
      mediatype: mediaType,
      media: base64,
      caption: caption || '',
    });
    return response.data;
  }

  /**
   * Send vCard contact
   */
  async sendVCard(phone: string, vcard: string, instanceName?: string, apiKeyOverride?: string) {
    const instance = instanceName || this.defaultInstance;
    const client = this.getClient(apiKeyOverride);
    const response = await client.post(`/message/sendContact/${instance}`, {
      number: phone,
      contact: [
        {
          fullName: 'Contact',
          wuid: phone,
          phoneNumber: phone,
          vcard,
        },
      ],
    });
    return response.data;
  }

  /**
   * Check instance availability
   */
  async isInstanceAvailable(instanceName?: string, apiKeyOverride?: string): Promise<boolean> {
    try {
      const status = await this.getInstanceStatus(instanceName, apiKeyOverride);
      return status?.instance?.state === 'open';
    } catch {
      return false;
    }
  }
}
