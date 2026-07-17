export const runAgentToolUpdate = async (
  setUpdating: (updating: boolean) => void,
  update: () => Promise<void>,
): Promise<void> => {
  setUpdating(true);
  try {
    await update();
  } finally {
    setUpdating(false);
  }
};
