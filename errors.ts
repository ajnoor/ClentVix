/** Errors whose message is safe to show to the signed-in user. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'HttpError'
  }
}

export class ConfigError extends HttpError {
  constructor(message: string) {
    super(message, 503)
    this.name = 'ConfigError'
  }
}
