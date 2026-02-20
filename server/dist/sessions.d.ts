import type { Session, CreateSessionRequest, ServerMessage, SessionSummaryDTO, SessionDTO } from "./types.js";
export declare function listSessions(): SessionSummaryDTO[];
export declare function listSessionsWithHistory(cwd?: string): Promise<SessionSummaryDTO[]>;
export declare function sessionToDTO(session: Session): SessionDTO;
export declare function getSession(id: string): Session | undefined;
export declare function getSessionCount(): {
    active: number;
    total: number;
};
export declare function broadcast(session: Session, msg: ServerMessage): void;
export declare function createSession(req: CreateSessionRequest): Promise<Session>;
export declare function interruptSession(id: string): boolean;
export declare function handleApproval(session: Session, toolUseId: string, allow: boolean, message?: string, answers?: Record<string, string>, alwaysAllow?: boolean): boolean;
export declare function sendFollowUp(session: Session, text: string): Promise<boolean>;
/** Abort all sessions, terminate WS clients, and clear the session map. For tests. */
export declare function clearSessions(): void;
