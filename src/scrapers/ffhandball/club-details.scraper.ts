import * as cheerio from "cheerio";
import { rawClubPayloadSchema, type RawClubPayload } from "@/schemas/club.schema.js";
import { rawSallePayloadSchema, type RawSallePayload } from "@/schemas/salle.schema.js";

export interface ClubDetailResult {
  club: RawClubPayload;
  salle: RawSallePayload | null;
}

function deptFromZipcode(zip: string | undefined | null): string | undefined {
  if (!zip || zip.length < 2) return undefined;
  if (zip.startsWith("97") || zip.startsWith("98")) return zip.slice(0, 3);
  if (zip.startsWith("20")) {
    return Number(zip) < 20200 ? "2A" : "2B";
  }
  return zip.slice(0, 2);
}

function slugifySalle(
  nom: string,
  cp: string | undefined,
  ville: string | undefined,
): string {
  return [nom, cp ?? "", ville ?? ""]
    .join("-")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function cleanString(s: unknown): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

export function parseClubDetail(
  html: string,
  sourceUrl: string,
): ClubDetailResult | null {
  const $ = cheerio.load(html);
  const el = $("smartfire-component[name='single-club---home-hero-club']").first();
  const raw = el.attr("attributes");
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = data as { post?: Record<string, unknown> } | null;
  const post = root?.post;
  const acf = post?.acf as Record<string, unknown> | undefined;
  if (!post || !acf) return null;

  const id_ffhb = cleanString(acf.id_club);
  const nom = cleanString(post.post_title);
  if (!id_ffhb || !nom) return null;

  // --- Salle (gyms_club[0] when array) ---
  const gyms = acf.gyms_club;
  let salle: RawSallePayload | null = null;
  if (Array.isArray(gyms) && gyms.length > 0) {
    const g = gyms[0] as Record<string, unknown>;
    const gymNom = cleanString(g.name_gym);
    const gymCp = cleanString(g.zipcode_gym);
    const gymVille = cleanString(g.city_gym);
    if (gymNom) {
      const salleId = slugifySalle(gymNom, gymCp, gymVille);
      const salleCandidate = {
        id_ffhb: salleId,
        nom: gymNom,
        adresse: cleanString(g.adress_gym),
        code_postal: gymCp,
        ville: gymVille,
        departement_code: deptFromZipcode(gymCp),
        latitude: g.latitude_gym,
        longitude: g.longitude_gym,
        source_url: sourceUrl,
        source_club_id_ffhb: id_ffhb,
      };
      const parsedSalle = rawSallePayloadSchema.safeParse(salleCandidate);
      if (parsedSalle.success) {
        salle = parsedSalle.data;
      }
    }
  }

  // --- Club ---
  const zipcode_club = cleanString(acf.zipcode_club);
  const departement_code = deptFromZipcode(zipcode_club);

  // Adresse: concat address_club + address_club_2 (omit address_club_2 if empty or equals post_title)
  const addr1 = cleanString(acf.address_club);
  const addr2Raw = cleanString(acf.address_club_2);
  const addr2 =
    addr2Raw && addr2Raw.toLowerCase() !== nom.toLowerCase() ? addr2Raw : undefined;
  const adresseCorrespondance =
    addr1 && addr2 ? `${addr1} ${addr2}` : (addr1 ?? addr2);

  // site_web: filter out "http://" placeholder
  const urlClub = cleanString(acf.url_club);
  const site_web = urlClub && urlClub.toLowerCase() !== "http://" ? urlClub : undefined;

  const clubCandidate = {
    id_ffhb,
    nom,
    slug: cleanString(post.post_name),
    ville: cleanString(acf.city_club),
    departement_code,
    source_url: sourceUrl,
    telephone: cleanString(acf.tel_club),
    email: cleanString(acf.email_club),
    site_web,
    adresse_correspondance: adresseCorrespondance,
    latitude: acf.latitude_club,
    longitude: acf.longitude_club,
    register_link: cleanString(acf.register_link),
    logo_club: cleanString(acf.logo_club),
    nb_licence_senior_h: acf.nb_licence_senior_h_club,
    nb_licence_senior_f: acf.nb_licence_senior_f_club,
    nb_licence_jeunes_h: acf.nb_licence_jeunes_h_club,
    nb_licence_jeunes_f: acf.nb_licence_jeunes_f_club,
    salle_principale_id_ffhb: salle?.id_ffhb,
  };

  const parsedClub = rawClubPayloadSchema.safeParse(clubCandidate);
  if (!parsedClub.success) return null;

  return { club: parsedClub.data, salle };
}
