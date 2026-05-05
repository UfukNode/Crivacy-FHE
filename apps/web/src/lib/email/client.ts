/**
 * Nodemailer transporter — singleton, TLS, connection pool.
 *
 * @module
 */

import type { Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type { EmailConfig } from './config';

let cachedTransporter: Transporter | null = null;

/**
 * Create or return cached nodemailer transporter.
 * Uses connection pooling for efficiency.
 */
export async function getTransporter(config: EmailConfig): Promise<Transporter> {
  if (cachedTransporter) return cachedTransporter;

  const nodemailer = await import('nodemailer');

  // `family` is a valid net.Socket option that nodemailer passes through,
  // but @types/nodemailer omits it from SMTPPool.Options. Runtime-safe.
  const opts: SMTPPool.Options & { family?: number } = {
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    // Force IPv4 — many networks lack IPv6 routes to Gmail/Google
    // Workspace SMTP, causing ENETUNREACH on the IPv6 AAAA record.
    family: 4,
    // Timeouts
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  };

  cachedTransporter = nodemailer.createTransport(opts);

  return cachedTransporter;
}

/**
 * Close the transporter connection pool.
 * Call on graceful shutdown.
 */
export function closeTransporter(): void {
  if (cachedTransporter) {
    cachedTransporter.close();
    cachedTransporter = null;
  }
}
