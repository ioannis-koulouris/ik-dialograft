import nodemailer from 'nodemailer';

/**
 * Generic local test mail adapter (Mailpit). Infrastructure only: there is deliberately no reminder
 * rule or scheduling here. Refuses every recipient outside the reserved .invalid TLD.
 */
export class TestMailer {
  private transport;
  constructor(host: string, port: number) {
    this.transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
  }

  static assertTestRecipient(address: string) {
    if (!/^[^@\s]+@[^@\s]+\.invalid$/i.test(address)) throw new Error(`refusing non-test recipient ${address}`);
  }

  async send(msg: { to: string; subject: string; text: string }) {
    TestMailer.assertTestRecipient(msg.to);
    const info = await this.transport.sendMail({ from: 'Dialograft Demo <demo@dialograft.invalid>', ...msg, headers: { 'X-Dialograft-Demo': '1' } });
    return { messageId: info.messageId };
  }
}
