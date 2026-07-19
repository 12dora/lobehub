export const EMAIL_REGEX = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
export const USERNAME_REGEX = /^\w+$/;

export const shouldShowLocalEmailForm = (input: {
  disableEmailPassword?: boolean;
  hasConfiguredDatabaseProvider: boolean;
  isSocialOnly: boolean;
}): boolean =>
  (!input.disableEmailPassword || input.hasConfiguredDatabaseProvider) && !input.isSocialOnly;
