import { google } from 'googleapis';
import { config } from '../config';
import { ofLogger } from '../utils/logger';
import { getGoogleAuth } from './googleDrive';

interface Attachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface EmailOptions {
  to: string[];
  subject: string;
  html: string;
  attachments?: Attachment[];
}

/**
 * Build a raw RFC 2822 MIME message with optional attachments.
 */
function buildRawEmail(options: EmailOptions): string {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const to = options.to.join(', ');

  const headers = [
    `From: ${config.emailFrom}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(options.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
  ];

  if (options.attachments && options.attachments.length > 0) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts: string[] = [];

    // HTML body part
    parts.push(
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(options.html).toString('base64'),
    );

    // Attachment parts
    for (const att of options.attachments) {
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.contentType}; name="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        att.content.toString('base64'),
      );
    }

    parts.push(`--${boundary}--`);

    return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  }

  // Simple HTML email without attachments
  headers.push('Content-Type: text/html; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: base64');
  return (
    headers.join('\r\n') +
    '\r\n\r\n' +
    Buffer.from(options.html).toString('base64')
  );
}

/**
 * Send an email via the Gmail API.
 */
async function sendEmail(options: EmailOptions): Promise<void> {
  const auth = await getGoogleAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildRawEmail(options);
  const encodedMessage = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  });
}

/**
 * Send the success confirmation email with OF attachments.
 */
export async function sendConfirmationEmail(
  ofNumber: string,
  dropboxLink: string,
  zipBuffer: Buffer,
  pdfBuffer: Buffer,
  docxBuffer: Buffer,
): Promise<void> {
  const log = ofLogger(ofNumber);
  log.info('Sending confirmation email');

  const html = `<p>Bonjour,</p>

<p>Le dossier <strong>${ofNumber}</strong> a été créé avec succès 📁</p>

<p>Vous trouverez en pièce jointe :</p>

<ul>
  <li>L'archive ZIP des plans PDF 📦</li>
  <li>Le dossier contenant les fichiers STEP 📐</li>
  <li>Le fichier Word récapitulatif 📄</li>
  <li>Le fichier PDF récapitulatif 📄</li>
</ul>

<p>Lien Dropbox : 🔗 <a href="${dropboxLink}">${dropboxLink}</a></p>`;

  await sendEmail({
    to: config.emailRecipients,
    subject: `New OF Files - ${ofNumber}`,
    html,
    attachments: [
      {
        filename: `NM${ofNumber}.zip`,
        content: zipBuffer,
        contentType: 'application/zip',
      },
      {
        filename: `${ofNumber}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
      {
        filename: `${ofNumber}.docx`,
        content: docxBuffer,
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ],
  });

  log.info('Confirmation email sent');
}

/**
 * Send an error alert email when a plan file is not found in Dropbox.
 */
export async function sendErrorEmail(ofNumber: string): Promise<void> {
  const log = ofLogger(ofNumber);
  log.info('Sending error alert email');

  const html = `<p>Bonjour,</p>

<p>Il y a eu une erreur de saisie d'un des plans 📁</p>

<p>Essayez à nouveau. Si l'erreur se répète, contacter denys@mozzistudio.com</p>`;

  await sendEmail({
    to: config.emailRecipients,
    subject: `New OF Files - OF${ofNumber}`,
    html,
  });

  log.info('Error alert email sent');
}
