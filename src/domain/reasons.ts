import type { AttributionConfig, AttributionWindow, TouchFact } from "./attribution.ts";
import { DAY_MS, HOUR_MS } from "./time.ts";

const iso = (ms: number) => new Date(ms).toISOString();

export function duration(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} ${ms === DAY_MS ? "dia" : "dias"}`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  return `${Math.round(ms / 60_000)} min`;
}

const label = (t: Pick<TouchFact, "kind" | "ref">) => `${t.kind} ${t.ref}`;

export const noFirstOpen = () =>
  "Nenhuma primeira abertura do app registrada para este cadastro (install_id ausente ou desconhecido); sem janela para medir a origem.";

export const installAlreadyUsed = () =>
  "Este install_id já foi usado no cadastro de outro usuário; a origem pertence ao primeiro cadastro.";

export const noTouches = () =>
  "O app não reportou nenhum toque de link antes do cadastro; origem orgânica.";

export const noEligibleTouch = (count: number) =>
  `${count} toque(s) reportado(s), mas nenhum elegível (veja o motivo de cada um); origem orgânica.`;

export const windowExpired = (signedUpAt: number, w: AttributionWindow, c: AttributionConfig) =>
  `Cadastro em ${iso(signedUpAt)} depois do fim da janela (${iso(w.endsAt)}, ${duration(c.windowMs)} após a primeira abertura); origem orgânica.`;

export const afterSignup = (t: Pick<TouchFact, "at" | "openedAt">, signedUpAt: number) =>
  t.at > signedUpAt
    ? `Toque em ${iso(t.at)} é posterior ao cadastro (${iso(signedUpAt)}); não conta.`
    : `Clique em ${iso(t.at)}, mas o app só abriu o link em ${iso(t.openedAt)}, depois do cadastro (${iso(signedUpAt)}); não conta.`;

export const touchOfUsedInstall = () =>
  "Toque desta instalação, que já foi atribuída ao cadastro de outro usuário; não é reavaliado.";

export function outsideWindow(at: number, w: AttributionWindow, c: AttributionConfig) {
  return at < w.startsAt
    ? `Toque em ${iso(at)} é anterior ao início da janela (${iso(w.startsAt)}): mais de ${duration(c.preInstallLookbackMs)} antes da primeira abertura (${iso(w.firstOpenedAt)}).`
    : `Toque em ${iso(at)} é posterior ao fim da janela (${iso(w.endsAt)}): mais de ${duration(c.windowMs)} após a primeira abertura (${iso(w.firstOpenedAt)}).`;
}

export const signupAfterWindow = (signedUpAt: number, w: AttributionWindow, c: AttributionConfig) =>
  `Toque dentro da janela, mas o cadastro (${iso(signedUpAt)}) veio depois do fim dela (${iso(w.endsAt)}, ${duration(c.windowMs)} após a primeira abertura).`;

export const won = (t: TouchFact, tiedWith: number) =>
  tiedWith === 0
    ? `Último toque elegível antes do cadastro: ${label(t)} em ${iso(t.at)}.`
    : `Empatou em ${iso(t.at)} com ${tiedWith} outro(s) toque(s) e venceu o desempate: prioridade de tipo (referral > campaign > community) e, se igual, menor identificador.`;

export const lostToLater = (winner: TouchFact) =>
  `Perdeu para um toque elegível mais recente: ${label(winner)} em ${iso(winner.at)} (regra: o último toque vence).`;

export const lostTieBreak = (loser: TouchFact, winner: TouchFact) =>
  loser.kind !== winner.kind
    ? `Empatou em ${iso(loser.at)} com ${label(winner)}; perdeu pela prioridade de tipo (referral > campaign > community).`
    : `Empatou em ${iso(loser.at)} com ${label(winner)} e o mesmo tipo; perdeu pelo identificador (${winner.tieKey} vem antes de ${loser.tieKey}).`;

export const duplicateClick = (t: TouchFact) =>
  `O mesmo clique (${t.tieKey}) foi reportado mais ${t.duplicateReports} vez(es); conta uma só vez, no toque ${t.id}.`;
