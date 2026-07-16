import axios from 'axios';
import { logger } from '../../utils/logger';

export class WhatsAppService {
  private token: string;
  private phoneNumberId: string;
  private baseUrl = 'https://graph.facebook.com/v19.0';

  constructor(token: string, phoneNumberId: string) {
    this.token = token;
    this.phoneNumberId = phoneNumberId;
  }

  async sendMessage(to: string, message: string) {
    try {
      const url = `${this.baseUrl}/${this.phoneNumberId}/messages`;
      const data = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      };

      const response = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      });
      
      logger.info('WhatsApp message sent', { messageId: response.data.messages[0].id });
      return true;
    } catch (error) {
      logger.error('Failed to send WhatsApp message', { error: (error as Error).message });
      throw error;
    }
  }
}
