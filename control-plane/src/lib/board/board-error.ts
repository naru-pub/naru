// A failure the person can act on. Its message is shown as is. Apart from
// errors.ts, whose responses need Next, so the jobs image's CLIs (which run
// automatic template updates) can use it.
export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
