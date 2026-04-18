export type Role = "USER" | "ADMIN";

export type PublicUser = {
  id: string;
  email: string;
  fullName?: string | null;
  role: Role;
  creditsBalance: number;
  creditsReserved: number;
  creditsAvailable: number;
  hasBniUsername: boolean;
  maxProfileConcurrency: number;
  maxCountryProfiles: number;
  requestDelayMin: number;
  requestDelayMax: number;
  headless: boolean;
};

export type LeadRequestStatus = "COUNTING" | "AWAITING_APPROVAL" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type MailCampaignStatus = "DRAFT" | "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED";
export type MailRecipientStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED";
export type MailCampaignSourceType = "GENERATED_LEADS" | "CUSTOM_UPLOAD" | "COMBINED";
export type MailCampaignChatRole = "USER" | "ASSISTANT";

export type LeadRequest = {
  id: string;
  userId: string;
  keyword: string | null;
  country: string;
  category: string | null;
  filename: string;
  totalLeads: number;
  requiredCredits: number;
  estimatedMinutes: number;
  uuidCsvPath: string | null;
  csvPath: string | null;
  status: LeadRequestStatus;
  cancelReason: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};

export type MailRecipient = {
  id: string;
  campaignId: string;
  userId: string;
  rowIndex: number;
  name: string;
  company: string | null;
  email: string;
  website: string | null;
  city: string | null;
  country: string | null;
  professionalDetails: string | null;
  sourceType: MailCampaignSourceType;
  status: MailRecipientStatus;
  emailSubject: string | null;
  emailBody: string | null;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type MailCampaign = {
  id: string;
  userId: string;
  sourceType: MailCampaignSourceType;
  leadRequestId: string | null;
  inputFileName: string | null;
  inputFileKey: string | null;
  inputFileUrl: string | null;
  companyWebsitePrimary: string;
  companyWebsiteSecondary: string;
  companyWebsiteTertiary: string | null;
  socialLinkedIn: string | null;
  socialInstagram: string | null;
  socialFacebook: string | null;
  phoneNumber: string | null;
  customInstructions: string | null;
  serviceSummary: string | null;
  draftSubject: string | null;
  draftBody: string | null;
  totalRecipients: number;
  creditsReserved: number;
  creditsCharged: number;
  sentCount: number;
  failedCount: number;
  status: MailCampaignStatus;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  updatedAt?: string;
  recipients?: MailRecipient[];
  messages?: MailCampaignChatMessage[];
};

export type MailCampaignChatMessage = {
  id: string;
  campaignId: string;
  userId: string;
  role: MailCampaignChatRole;
  content: string;
  draftSubject: string | null;
  draftBody: string | null;
  createdAt: string;
};

export type CreditApplication = {
  id: string;
  userId: string;
  requestedCredits: number;
  note: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  adminId: string | null;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CategoryItem = {
  label: string;
  value?: string;
};
