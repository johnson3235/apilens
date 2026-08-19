import { useState, useEffect } from 'react';
import { Rule } from '@apilens/shared-types/rule';

export function useRules() {
  const [rules, setRules] = useState<Rule[]>([]);

  useEffect(() => {
    if (chrome && chrome.storage) {
      chrome.storage.local.get('apilens_rules', (data) => {
        if (data.apilens_rules) {
          setRules(data.apilens_rules);
        }
      });
    }
  }, []);

  const addRule = (rule: Rule) => setRules(prev => [...prev, rule]);
  const removeRule = (id: string) => setRules(prev => prev.filter(r => r.id !== id));
  const updateRule = (rule: Rule) => setRules(prev => prev.map(r => r.id === rule.id ? rule : r));
  
  return { rules, addRule, removeRule, updateRule };
}
