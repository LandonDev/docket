import { HostLine } from "../shell/DownLine";
import { HostLinkLine, useHostLinkDown } from "../shell/hostLinkDown";
import { useLifeosStatus } from "../shell/lifeos";
import { useHostLive } from "../shell/lifeosLive";

/** Google accounts come from the host's LifeOS. An empty answer while that session is down says nothing about accounts. */
export function useAccountReach(environmentId: string) {
  const status = useLifeosStatus(environmentId);
  const live = useHostLive(environmentId);
  const linkDown = useHostLinkDown(environmentId);
  return {
    checking: status === null,
    held: !!(linkDown || live.down || live.waits),
    line: linkDown ? <HostLinkLine word={linkDown} retryHost={environmentId} /> : <HostLine live={live} />,
  };
}
