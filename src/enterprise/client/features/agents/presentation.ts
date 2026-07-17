import type { PlatformEffectiveAgent } from '@lobechat/types';

export interface PlatformAgentPresentation {
  canHide: boolean;
  hideFeedback: 'hidden' | 'locked' | 'visible';
  managedFieldsEditable: false;
  source: 'organization';
}

/** User-side policy adapter: platform fields are managed; only non-mandatory rows may hide. */
export const getPlatformAgentPresentation = (
  agent: PlatformEffectiveAgent,
  hidden: boolean,
): PlatformAgentPresentation => {
  const canHide = agent.distribution !== 'mandatory';
  return {
    canHide,
    hideFeedback: canHide ? (hidden ? 'hidden' : 'visible') : 'locked',
    managedFieldsEditable: false,
    source: 'organization',
  };
};
