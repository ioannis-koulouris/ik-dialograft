/** Aggregate kinds stored by the store. Features add their own kinds here; the store itself stays protected. */
export const KINDS = ['customer', 'quote', 'invoice', 'export', 'feature_request', 'order', 'payment_reminder', 'payment_reminder_2'] as const;
export type Kind = (typeof KINDS)[number];
