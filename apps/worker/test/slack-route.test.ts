import { describe, expect, it } from "vitest";
import { slackMessageSubject } from "../src/routes/slack.js";

describe("slackMessageSubject", () => {
  it("maps root channel messages to their own thread", () => {
    expect(
      slackMessageSubject({
        type: "message",
        channel_type: "channel",
        channel: "C123",
        user: "U123",
        text: "see acme-corp/web-backend#3809",
        ts: "1782220000.000100",
      }),
    ).toEqual({
      channel: "C123",
      channelType: "channel",
      user: "U123",
      text: "see acme-corp/web-backend#3809",
      threadTs: "1782220000.000100",
    });
  });

  it("maps top-level app mentions to their own thread", () => {
    expect(
      slackMessageSubject({
        type: "app_mention",
        channel_type: "channel",
        channel: "C123",
        user: "U123",
        text: "<@UAIPM> see acme-corp/web-backend#3809",
        ts: "1782220000.000100",
      }),
    ).toEqual({
      channel: "C123",
      channelType: "channel",
      user: "U123",
      text: "<@UAIPM> see acme-corp/web-backend#3809",
      threadTs: "1782220000.000100",
    });
  });

  it("maps thread replies delivered as message_replied to the parent thread", () => {
    expect(
      slackMessageSubject({
        type: "message",
        subtype: "message_replied",
        channel: "C123",
        message: {
          user: "UROOT",
          text: "root",
          ts: "1782220000.000100",
          thread_ts: "1782220000.000100",
          replies: [{ user: "U123", ts: "1782220001.000200" }],
        },
      }),
    ).toEqual({
      channel: "C123",
      channelType: "channel",
      user: "U123",
      text: "root",
      threadTs: "1782220000.000100",
    });
  });

  it("ignores bot messages and non-threading subtypes", () => {
    expect(
      slackMessageSubject({
        type: "message",
        channel_type: "channel",
        channel: "C123",
        bot_id: "B123",
        ts: "1782220000.000100",
      }),
    ).toBeUndefined();
    expect(
      slackMessageSubject({
        type: "message",
        subtype: "message_changed",
        channel: "C123",
        ts: "1782220000.000100",
      }),
    ).toBeUndefined();
  });
});
