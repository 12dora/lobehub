export const createBrandingNavigationDecision = (params: {
  onCancel: () => void;
  onProceed: () => void;
}) => {
  let settled = false;
  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      params.onCancel();
    },
    proceed: () => {
      if (settled) return;
      settled = true;
      params.onProceed();
    },
  };
};
