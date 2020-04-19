import React from "react";
import useSWR from "swr";
import { DisplayError } from "../components/DisplayError";
import { fetchJSON } from "../components/fetchJSON";
import { Loading } from "../components/Loading";
import { LayerInfo } from "./LayerInfo";
import { server } from "../server";

export const addressFilter = (_: string) => _.startsWith("0x");

export const shortenAddress = (address: string) => [address.substr(0, 6), address.substr(-4)].join("...");

export const commsServer = `https://${server}/comms/`;

export function Comms() {
  const { data: comms, error: error1 } = useSWR(commsServer + "status", fetchJSON);
  const { data, error } = useSWR(commsServer + "layers", fetchJSON);
  const layers = data ? data.filter((_: any) => _.usersCount > 0) : [];
  if (!layers) {
    return <Loading />;
  }
  return (
    <div>
      <h3>
        Comms{" "}
        {comms && (
          <span>
            ({layers.length} layer{layers.length !== 1 ? "s" : ""} with users)
          </span>
        )}{" "}
      </h3>
      {comms && (
        <>
          {layers.map((_: any) => (
            <LayerInfo {..._} key={_.name} serverName={comms.name} layerName={_.name} />
          ))}
        </>
      )}
      <DisplayError error={error} />
      <DisplayError error={error1} />
    </div>
  );
}
