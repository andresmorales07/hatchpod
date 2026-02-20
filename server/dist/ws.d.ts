import type { WebSocket } from "ws";
export declare function extractSessionIdFromPath(pathname: string): string | null;
export declare function handleWsConnection(ws: WebSocket, sessionId: string, ip: string): void;
