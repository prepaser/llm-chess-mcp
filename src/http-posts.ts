export type HttpPostScope = {
  activePosts: number;
};

export type HttpPostLease = {
  release(): void;
};

export type HttpBodyLease = HttpPostLease & {
  preemptSignal: AbortSignal;
};

export class HttpPostAdmission<T extends HttpPostScope> {
  #activeGlobal = 0;

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerSession: number,
  ) {}

  tryAcquire(session?: T): HttpPostLease | 429 | 503 {
    if (session && session.activePosts >= this.maxPerSession) return 429;
    if (this.#activeGlobal >= this.maxGlobal) return 503;

    this.#activeGlobal += 1;
    if (session) session.activePosts += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.#activeGlobal -= 1;
        if (session) session.activePosts -= 1;
      },
    };
  }
}

export class HttpBodyAdmission {
  #activePrimary = 0;
  readonly #controls = new Set<() => void>();

  constructor(
    private readonly maxPrimary: number,
    private readonly maxControl: number,
  ) {}

  acquire(): HttpBodyLease {
    if (this.#activePrimary < this.maxPrimary) {
      this.#activePrimary += 1;
      let released = false;
      return {
        preemptSignal: new AbortController().signal,
        release: (): void => {
          if (released) return;
          released = true;
          this.#activePrimary -= 1;
        },
      };
    }

    if (this.#controls.size >= this.maxControl) {
      this.#controls.values().next().value?.();
    }
    const controller = new AbortController();
    let released = false;
    let preempt!: () => void;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#controls.delete(preempt);
    };
    preempt = (): void => {
      release();
      controller.abort();
    };
    this.#controls.add(preempt);
    return { preemptSignal: controller.signal, release };
  }
}
