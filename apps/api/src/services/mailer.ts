import nodemailer from "nodemailer";
import { env } from "../lib/env";

type MailCredentials = {
  senderEmail: string;
  appPassword: string;
};

type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

function createTransporter(credentials: MailCredentials) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: credentials.senderEmail,
      pass: credentials.appPassword,
    },
  });
}

export async function sendMailWithCredentials(credentials: MailCredentials, message: MailMessage): Promise<void> {
  if (!credentials.senderEmail || !credentials.appPassword) {
    throw new Error("Sending email credentials are not configured");
  }
  const transporter = createTransporter(credentials);
  await transporter.sendMail({
    from: credentials.senderEmail,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  if (!env.googleSenderEmail || !env.googleAppPassword) return;
  await sendMailWithCredentials(
    {
      senderEmail: env.googleSenderEmail,
      appPassword: env.googleAppPassword,
    },
    {
      to,
      subject: "Reset your BNI Lead Gen password",
      text: `Reset your password here: ${resetUrl}`,
      html: `<p>Reset your password here:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`,
    }
  );
}
