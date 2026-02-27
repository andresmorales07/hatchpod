import type { IncomingMessage, ServerResponse } from "node:http";
export declare function requirePassword(): void;
declare function getClientIp(req: IncomingMessage): string;
export declare function authenticateRequest(req: IncomingMessage): boolean | "rate_limited";
export declare function authenticateToken(token: string, ip: string): boolean | "rate_limited";
export declare const getRequestIp: typeof getClientIp;
export declare function sendUnauthorized(res: ServerResponse): void;
export declare function sendRateLimited(res: ServerResponse): void;
export {};
