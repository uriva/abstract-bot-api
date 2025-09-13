import { assertEquals } from "@std/assert";
import { getBestPhoneFromContactShared } from "./telegram.ts";

const alicePhone = "972521111111";

Deno.test("parse vcard", () => {
  assertEquals(
    getBestPhoneFromContactShared({
      phone_number: "+97236746666",
      first_name: "Alice",
      last_name: "Smith",
      vcard: `BEGIN:VCARD
VERSION:2.1
N:Smith;Alice;;;
FN:Alice Smith
EMAIL;PREF:alice@gmail.com
EMAIL:alice@mail.huji.ac.il
EMAIL:alice@google.com
TEL;CELL;PREF:+${alicePhone}
TEL;HOME:+97236746666
END:VCARD`,
    }),
    `+${alicePhone}`,
  );
});
