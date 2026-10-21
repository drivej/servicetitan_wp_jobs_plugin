export interface WorkContentSource {
  source: 'invoices' | 'forms';
  state: 'available' | 'unavailable' | 'partial';
  message: string;
}
export interface FormFinding { question: string; answer: string; }
export interface WorkContent {
  workSummary?: string;
  invoiceSummaries?: string[];
  invoiceWorkItems?: string[];
  formFindings?: FormFinding[];
  contentSources?: WorkContentSource[];
}
