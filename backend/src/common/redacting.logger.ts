import { ConsoleLogger } from '@nestjs/common';
import { redactValue } from './redact';

/** Console logger that scrubs API keys, secrets, signatures, cookies and auth headers from every line. */
export class RedactingLogger extends ConsoleLogger {
  log(message: any, ...rest: any[]) { super.log(redactValue(message), ...rest.map(redactValue)); }
  error(message: any, ...rest: any[]) { super.error(redactValue(message), ...rest.map(redactValue)); }
  warn(message: any, ...rest: any[]) { super.warn(redactValue(message), ...rest.map(redactValue)); }
  debug(message: any, ...rest: any[]) { super.debug(redactValue(message), ...rest.map(redactValue)); }
  verbose(message: any, ...rest: any[]) { super.verbose(redactValue(message), ...rest.map(redactValue)); }
  fatal(message: any, ...rest: any[]) { super.fatal(redactValue(message), ...rest.map(redactValue)); }
}
