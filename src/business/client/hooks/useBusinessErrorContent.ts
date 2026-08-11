import { type ErrorType } from '@lobechat/types';

export interface BusinessErrorContentResult {
  errorType?: string;
  hideMessage?: boolean;
  /** Optional override message (e.g. cloud-formatted empty-completion cost). */
  message?: string;
}

export default function useBusinessErrorContent(
  // eslint-disable-next-line unused-imports/no-unused-vars
  errorType?: ErrorType | string,
): BusinessErrorContentResult {
  return {};
}
