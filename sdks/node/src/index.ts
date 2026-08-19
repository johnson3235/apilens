export * from './context';
export * from './middleware';
export * from './http-interceptor';
export * from './trace-reporter';
export * from './redaction';

import { apiLensMiddleware } from './middleware';
import { TraceReporter } from './trace-reporter';
import { enableHttpInterception, disableHttpInterception } from './http-interceptor';

export interface ApiLensSDKOptions {
  serviceName: string;
  reporterUrl?: string;
  enabled?: boolean;
}

export class ApiLensSDK {
  public readonly options: ApiLensSDKOptions;
  public readonly reporter: TraceReporter;

  constructor(options: ApiLensSDKOptions) {
    this.options = {
      enabled: true,
      ...options,
    };
    
    this.reporter = new TraceReporter(this.options.reporterUrl);

    if (this.options.enabled) {
      enableHttpInterception(this.reporter, this.options.serviceName);
    }
  }

  public expressMiddleware() {
    return apiLensMiddleware({
      serviceName: this.options.serviceName,
      reporterUrl: this.options.reporterUrl,
      enabled: this.options.enabled,
    });
  }

  public shutdown() {
    disableHttpInterception();
    this.reporter.shutdown();
  }
}

export let globalSdk: ApiLensSDK | null = null;

export function configure(options: ApiLensSDKOptions): ApiLensSDK {
  if (!globalSdk) {
    globalSdk = new ApiLensSDK(options);
  }
  return globalSdk;
}
