/** Per-request Hono variables shared by every route. */
import type { Logger } from '../log';

export interface AuthInfo {
  userId: string;
  sessionId: string;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    /** pino child logger carrying `reqId` */
    log: Logger;
    /** set by requireAuth / optionalAuth */
    auth: AuthInfo | null;
  };
};
