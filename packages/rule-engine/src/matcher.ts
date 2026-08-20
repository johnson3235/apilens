import { Rule, MatchCondition, CapturedRequest, RuleEvaluationResult } from '@apilens/shared-types';

export class RuleMatcher {
  
  public findMatchingRule(rules: Rule[], request: CapturedRequest): RuleEvaluationResult {
    // Sort rules by priority (lower number = higher priority)
    const sortedRules = [...rules].sort((a, b) => a.priority - b.priority);

    for (const rule of sortedRules) {
      if (!rule.enabled) {
        continue;
      }

      const isMatch = this.evaluateRule(rule, request);
      
      if (isMatch) {
        return {
          matched: true,
          rule: rule,
          action: rule.action,
          reason: `Matched rule: ${rule.name}`
        };
      }
    }

    return {
      matched: false,
      rule: null,
      action: null,
      reason: 'No rules matched'
    };
  }

  public evaluateRule(rule: Rule, request: CapturedRequest): boolean {
    if (rule.applyMode === 'once' && rule.appliedCount >= 1) return false;
    if (rule.applyMode === 'n-times' && rule.applyLimit !== undefined && rule.appliedCount >= rule.applyLimit) return false;
    if (rule.applyMode === 'probability' && rule.applyProbability !== undefined) {
      if (Math.random() * 100 >= rule.applyProbability) return false;
    }

    if (rule.conditions.length === 0) {
      return true;
    }

    const evaluations = rule.conditions.map(condition => this.evaluateCondition(condition, request));

    if (rule.conditionLogic === 'and') {
      return evaluations.every(v => v);
    } else {
      return evaluations.some(v => v);
    }
  }

  public evaluateCondition(condition: MatchCondition, request: CapturedRequest): boolean {
    let targetValue: string | undefined = undefined;

    switch (condition.field) {
      case 'url':
        targetValue = request.url;
        break;
      case 'path':
        targetValue = request.path;
        break;
      case 'method':
        targetValue = request.method;
        break;
      case 'hostname':
        targetValue = request.hostname;
        break;
      case 'query':
        if (condition.key) {
          const actualKey = Object.keys(request.queryParams).find(k => k.toLowerCase() === condition.key!.toLowerCase());
          targetValue = actualKey ? request.queryParams[actualKey] : undefined;
        }
        break;
      case 'header':
        if (condition.key) {
          const actualKey = Object.keys(request.requestHeaders).find(k => k.toLowerCase() === condition.key!.toLowerCase());
          targetValue = actualKey ? request.requestHeaders[actualKey] : undefined;
        }
        break;
      case 'body':
        targetValue = request.requestBody || undefined;
        break;
      case 'graphqlOperation':
        targetValue = request.graphqlOperation || undefined;
        break;
      case 'serviceName':
        targetValue = request.serviceName || undefined;
        break;
      case 'statusCode':
        targetValue = request.statusCode !== null ? request.statusCode.toString() : undefined;
        break;
    }

    if (condition.operator === 'exists') {
      return targetValue !== undefined && targetValue !== null;
    }
    
    if (condition.operator === 'notExists') {
      return targetValue === undefined || targetValue === null;
    }

    if (targetValue === undefined || targetValue === null) {
      return false;
    }

    const valueToMatch = condition.value;
    
    if (!condition.caseSensitive && condition.operator !== 'regex') {
      targetValue = targetValue.toLowerCase();
    }
    
    const compareValue = (!condition.caseSensitive && condition.operator !== 'regex') ? valueToMatch.toLowerCase() : valueToMatch;

    switch (condition.operator) {
      case 'equals':
        return targetValue === compareValue;
      case 'contains':
        return targetValue.includes(compareValue);
      case 'startsWith':
        return targetValue.startsWith(compareValue);
      case 'endsWith':
        return targetValue.endsWith(compareValue);
      case 'regex':
        try {
          const flags = condition.caseSensitive ? '' : 'i';
          const regex = new RegExp(compareValue, flags);
          return regex.test(targetValue);
        } catch (e) {
          return false;
        }
      default:
        return false;
    }
  }
}
