export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what: string, id: string) => new AppError(404, 'not_found', `${what} ${id} nicht gefunden.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const invalid = (message: string, details?: unknown) => new AppError(400, 'invalid_input', message, details);
