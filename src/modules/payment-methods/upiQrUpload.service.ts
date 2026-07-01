import {
  buildUpiQrConfigFields,
  decodeUpiQrFromImageBuffer,
  type ParsedUpiQr,
} from "../../lib/decodeUpiQrImage";
import { uploadUpiQrImageBuffer } from "../../services/cloudinaryUpiQr";

export type UpiQrUploadValidation = {
  valid: true;
  vpa: string;
  payeeName?: string;
  hasFixedAmount: boolean;
  message: string;
};

/**
 * Decode a bank UPI QR image, upload to storage, and return merged PaymentMethod config.
 */
export async function processUpiQrImageUpload(
  buffer: Buffer,
  societyId: string,
  existingConfig: Record<string, unknown> = {},
): Promise<{
  url: string;
  config: Record<string, unknown>;
  validation: UpiQrUploadValidation;
}> {
  const parsed: ParsedUpiQr = await decodeUpiQrFromImageBuffer(buffer);
  const url = await uploadUpiQrImageBuffer(buffer, societyId);
  const config = {
    ...existingConfig,
    ...buildUpiQrConfigFields(url, parsed),
  };

  const payeeLabel = parsed.payeeName ? ` · ${parsed.payeeName}` : "";
  const amountWarning = parsed.hasFixedAmount
    ? " (QR has a fixed amount — residents will pay the maintenance due via UPI app)"
    : "";

  return {
    url,
    config,
    validation: {
      valid: true,
      vpa: parsed.vpa,
      payeeName: parsed.payeeName,
      hasFixedAmount: parsed.hasFixedAmount,
      message: `Valid UPI QR · VPA: ${parsed.vpa}${payeeLabel}${amountWarning}`,
    },
  };
}
