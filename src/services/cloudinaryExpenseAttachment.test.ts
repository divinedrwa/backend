import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCloudinaryDeliveryUrl } from "./cloudinaryExpenseAttachment";

describe("parseCloudinaryDeliveryUrl", () => {
  it("parses legacy signed authenticated image URLs", () => {
    const url =
      "https://res.cloudinary.com/demo/image/authenticated/s--nSm1sWSW--/v1/divine-app/expenses/soc1/receipt?_a=BAMAPqWQ0";
    const parsed = parseCloudinaryDeliveryUrl(url);
    assert.ok(parsed);
    assert.equal(parsed.deliveryType, "authenticated");
    assert.equal(parsed.resourceType, "image");
    assert.equal(parsed.publicId, "divine-app/expenses/soc1/receipt");
  });

  it("parses public upload image URLs", () => {
    const url =
      "https://res.cloudinary.com/demo/image/upload/v1234567890/divine-app/expenses/soc1/receipt.jpg";
    const parsed = parseCloudinaryDeliveryUrl(url);
    assert.ok(parsed);
    assert.equal(parsed.deliveryType, "upload");
    assert.equal(parsed.publicId, "divine-app/expenses/soc1/receipt.jpg");
  });

  it("parses raw authenticated PDF URLs", () => {
    const url =
      "https://res.cloudinary.com/demo/raw/authenticated/s--abc--/v9/divine-app/expenses/soc1/invoice.pdf";
    const parsed = parseCloudinaryDeliveryUrl(url);
    assert.ok(parsed);
    assert.equal(parsed.resourceType, "raw");
    assert.equal(parsed.publicId, "divine-app/expenses/soc1/invoice.pdf");
  });
});
