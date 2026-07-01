/** NPCI-style UPI VPA: local-part @ PSP handle */
export const UPI_VPA_REGEX = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/;

export type ValidatedUpiVpa = {
  vpa: string;
  validatedAt: string;
};

/**
 * Validate and normalize a manually entered UPI VPA (admin UPI_VPA flow).
 */
export function validateUpiVpa(vpa: string): ValidatedUpiVpa {
  const trimmed = vpa.trim();
  if (!trimmed) {
    throw new Error("UPI VPA is required");
  }
  if (!UPI_VPA_REGEX.test(trimmed)) {
    throw new Error(
      "Invalid UPI VPA. Use the format name@bank (e.g. society@okhdfc, collection@yesbank).",
    );
  }
  return { vpa: trimmed, validatedAt: new Date().toISOString() };
}

export function isUpiVpaConfigReady(config: Record<string, unknown>): boolean {
  return (
    typeof config.vpa === "string" &&
    config.vpa.length > 0 &&
    typeof config.vpaValidatedAt === "string" &&
    config.vpaValidatedAt.length > 0
  );
}

/**
 * Apply VPA validation to PaymentMethod config. Re-validates when VPA changes.
 */
export function enrichUpiVpaConfig(
  config: Record<string, unknown>,
  existingConfig?: Record<string, unknown>,
): Record<string, unknown> {
  if (config.vpa === undefined && existingConfig) {
    return config;
  }

  const vpaInput = config.vpa;
  if (vpaInput === null || vpaInput === "") {
    return { ...config, vpa: null, vpaValidatedAt: null };
  }

  if (typeof vpaInput !== "string") {
    throw new Error("UPI VPA must be a string");
  }

  const validated = validateUpiVpa(vpaInput);
  const unchanged =
    existingConfig &&
    existingConfig.vpa === validated.vpa &&
    typeof existingConfig.vpaValidatedAt === "string" &&
    existingConfig.vpaValidatedAt.length > 0;

  return {
    ...config,
    vpa: validated.vpa,
    vpaValidatedAt: unchanged ? existingConfig!.vpaValidatedAt : validated.validatedAt,
  };
}

export function upiVpaValidationMessage(vpa: string): string {
  return `Valid UPI VPA · ${vpa}`;
}
