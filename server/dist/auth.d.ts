import type { IncomingMessage, ServerResponse } from "node:http";
export declare function requirePassword(): void;
export declare function authenticateRequest(req: IncomingMessage): boolean | "rate_limited";
export declare function authenticateToken(token: string, ip: string): boolean | "rate_limited";
export declare function getRequestIp(req: IncomingMessage): string;
export declare function sendUnauthorized(res: ServerResponse): void;
export declare function sendRateLimited(res: ServerResponse): void;
