import fs from "fs";
import os from "os";
import { future, IFuture } from "fp-future";
import equal from "fast-deep-equal";

export class SimpleStorage {
  private _currentItems: object | undefined;
  private _lastFlush: object | undefined;

  private _flushing: boolean = false;
  private _pendingFlushFutures: IFuture<void>[] = [];

  constructor(private filePath: string) {}

  async clear(): Promise<void> {
    this._currentItems = {};
    await this.flush();
  }

  async getCurrentItems(): Promise<object> {
    if (!this._currentItems) {
      let itemsJson: string | null = null;
      try {
        itemsJson = await fs.promises.readFile(this.filePath, "utf-8");
      } catch (err) {
        console.log("No server storage could be opened. Starting new one.");
      }

      this._currentItems = itemsJson ? JSON.parse(itemsJson) : {};
    }

    return this._currentItems!;
  }

  async getString(key: string): Promise<string | undefined> {
    const currentItems = await this.getCurrentItems();

    return currentItems[key] as string;
  }

  async getOrSetString(key: string, value: string): Promise<string | undefined> {
    const currentItems = await this.getCurrentItems();
    if (typeof currentItems[key] === "undefined") {
      currentItems[key] = value;
      await this.flush();
    }

    return currentItems[key] as string;
  }

  async setString(key: string, value: string) {
    const currentItems = await this.getCurrentItems();

    currentItems[key] = value;

    await this.flush();
  }

  private async flush() {
    if (!this._flushing) {
      try {
        this._flushing = true;
        await this.doFlush();
        let future: IFuture<void> | undefined;
        while ((future = this._pendingFlushFutures.shift())) {
          if (!equal(this._lastFlush, this._currentItems)) {
            await this.doFlush();
          }
          future.resolve();
        }
      } catch (err) {
        console.log("Error writing storage file " + this.filePath, err);
        let future: IFuture<void> | undefined;
        while ((future = this._pendingFlushFutures.shift())) {
          future.reject(err);
        }
      } finally {
        this._flushing = false;
      }
    } else {
      const futureFlush = future();
      this._pendingFlushFutures.push(futureFlush);
      await futureFlush;
    }
  }

  private async doFlush() {
    const toFlush = { ...this._currentItems };
    await fs.promises.writeFile(this.filePath, JSON.stringify(toFlush), "utf-8");
    this._lastFlush = toFlush;
  }
}

const localDir = process.env.LIGHTHOUSE_STORAGE_LOCATION ?? `${os.homedir()}/.lighthouse`;

if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir);
}

export const lighthouseStorage = new SimpleStorage(localDir + "/serverStorage.json");
