export type HttpPostScope = {
  activePosts: number;
};

export type HttpPostLease = {
  release(): void;
};

export type HttpBodyLease = HttpPostLease & {
  kind: "full" | "probe";
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
  #activeFull = 0;
  #activeProbes = 0;

  constructor(
    private readonly maxFull: number,
    private readonly maxProbes: number,
  ) {}

  acquire(): HttpBodyLease | undefined {
    if (this.#activeFull < this.maxFull) {
      this.#activeFull += 1;
      return this.lease("full", () => {
        this.#activeFull -= 1;
      });
    }
    if (this.#activeProbes >= this.maxProbes) {
      return undefined;
    }
    this.#activeProbes += 1;
    return this.lease("probe", () => {
      this.#activeProbes -= 1;
    });
  }

  private lease(
    kind: HttpBodyLease["kind"],
    onRelease: () => void,
  ): HttpBodyLease {
    let released = false;
    return {
      kind,
      release: (): void => {
        if (released) return;
        released = true;
        onRelease();
      },
    };
  }
}
