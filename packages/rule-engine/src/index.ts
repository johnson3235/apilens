export * from './matcher';
export * from './executor';

import { RuleMatcher } from './matcher';
import { RuleExecutor } from './executor';

export class RuleEngine {
  private matcher: RuleMatcher;
  private executor: RuleExecutor;

  constructor() {
    this.matcher = new RuleMatcher();
    this.executor = new RuleExecutor();
  }

  getMatcher(): RuleMatcher {
    return this.matcher;
  }

  getExecutor(): RuleExecutor {
    return this.executor;
  }
}
