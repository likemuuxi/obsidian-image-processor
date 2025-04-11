import { Modal, Notice } from "obsidian";
import { App } from "obsidian";

export class RefererModal extends Modal {
  defaultReferer: string = "";
  callback: (referer: string) => void;

  constructor(app: App, callback: (referer: string) => void) {
    super(app);
    this.callback = callback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("label", {
      text: "Please input referer(URL):",
    });
    contentEl.createEl("br");
    const input = contentEl.createEl("input", {
      type: "text",
      attr: { id: "referer-input" },
      placeholder: "https://example.com/xxx/",
    });
    input.style.margin = "0.6em";
    input.style.marginLeft = "0";
    input.style.width = "85%";
    if (this.defaultReferer) {
      input.value = this.defaultReferer;
    }

    const confirmButton = contentEl.createEl("button", { text: "OK" });
    confirmButton.addEventListener("click", () => {
      const referer = input.value;
      if (!referer) {
        new Notice("Referer is empty!");
      }
      this.callback(referer);
      this.close();
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        confirmButton.click();
      }
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}