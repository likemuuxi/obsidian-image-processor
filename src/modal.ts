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
    
    // 创建标题和输入框容器
    const inputContainer = contentEl.createDiv();
    inputContainer.createEl("label", {
      text: "Please input referer(URL):",
    });
    inputContainer.createEl("br");
    const input = inputContainer.createEl("input", {
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

    // 创建按钮容器
    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "space-between";
    buttonContainer.style.marginTop = "1em";

    // 添加下载所有附件按钮
    const downloadButton = buttonContainer.createEl("button", { 
      text: "Obsidian attachment download",
    });
    downloadButton.addEventListener("click", async () => {
      await (this.app as any).commands.executeCommandById("editor:download-attachments");
      this.close();
    });

    // 确认按钮
    const confirmButton = buttonContainer.createEl("button", { text: "OK" });
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