export type HttpSessionState = {
  lastUsedAt: number;
  activeRequests: number;
};

export type HttpSessionReservation<T extends HttpSessionState> = {
  attach(session: T): void;
  initialized(id: string): void;
  closed(id: string): void;
  close(): void;
  finish(): boolean;
};

export class HttpSessionRegistry<T extends HttpSessionState> {
  #sessions = new Map<string, T>();
  #initializing = new Set<T>();
  #pendingReservations = 0;

  constructor(private readonly maxSessions: number) {}

  get size(): number {
    return this.#sessions.size;
  }

  get(id: string): T | undefined {
    return this.#sessions.get(id);
  }

  tryReserve(): HttpSessionReservation<T> | undefined {
    if (this.#sessions.size + this.#pendingReservations >= this.maxSessions) {
      return undefined;
    }
    this.#pendingReservations += 1;
    return new SessionReservation({
      attach: (session) => this.#initializing.add(session),
      activate: (id, session) => {
        this.#initializing.delete(session);
        session.lastUsedAt = Date.now();
        this.#sessions.set(id, session);
      },
      detach: (session) => this.#initializing.delete(session),
      forget: (id, session) => {
        if (this.#sessions.get(id) === session) this.#sessions.delete(id);
      },
      release: () => {
        this.#pendingReservations -= 1;
      },
    });
  }

  async withActive<R>(session: T, work: () => Promise<R>): Promise<R> {
    session.activeRequests += 1;
    session.lastUsedAt = Date.now();
    try {
      return await work();
    } finally {
      session.activeRequests -= 1;
      session.lastUsedAt = Date.now();
    }
  }

  async close(
    id: string,
    session: T,
    stop: (session: T) => Promise<void>,
  ): Promise<void> {
    if (this.#sessions.get(id) !== session) return;
    this.#sessions.delete(id);
    await stop(session);
  }

  async reap(
    idleTtlMs: number,
    stop: (session: T) => Promise<void>,
  ): Promise<void> {
    const now = Date.now();
    await Promise.allSettled(
      [...this.#sessions.entries()]
        .filter(
          ([, session]) =>
            session.activeRequests === 0 && now - session.lastUsedAt >= idleTtlMs,
        )
        .map(([id, session]) => this.close(id, session, stop)),
    );
  }

  async closeAll(stop: (session: T) => Promise<void>): Promise<void> {
    const active = [...this.#sessions.values()];
    const initializing = [...this.#initializing];
    this.#sessions.clear();
    this.#initializing.clear();
    await Promise.allSettled([...active, ...initializing].map(stop));
  }
}

type SessionReservationOps<T extends HttpSessionState> = {
  attach(session: T): void;
  activate(id: string, session: T): void;
  detach(session: T): void;
  forget(id: string, session: T): void;
  release(): void;
};

class SessionReservation<T extends HttpSessionState> implements HttpSessionReservation<T> {
  #session: T | undefined;
  #id: string | undefined;
  #released = false;
  #activated = false;
  #finished = false;

  constructor(private readonly ops: SessionReservationOps<T>) {}

  attach(session: T): void {
    if (this.#finished || this.#session !== undefined) return;
    this.#session = session;
    this.ops.attach(session);
    this.activate();
  }

  initialized(id: string): void {
    if (this.#finished || this.#id !== undefined) return;
    this.#id = id;
    this.activate();
  }

  closed(id: string): void {
    if (this.#session) this.ops.forget(id, this.#session);
  }

  close(): void {
    if (this.#id && this.#session) this.ops.forget(this.#id, this.#session);
  }

  finish(): boolean {
    if (this.#finished) return this.#activated;
    this.#finished = true;
    if (this.#session) this.ops.detach(this.#session);
    if (!this.#activated) this.release();
    return this.#activated;
  }

  private activate(): void {
    if (this.#activated || !this.#session || !this.#id) return;
    this.#activated = true;
    this.release();
    this.ops.activate(this.#id, this.#session);
  }

  private release(): void {
    if (this.#released) return;
    this.#released = true;
    this.ops.release();
  }
}
