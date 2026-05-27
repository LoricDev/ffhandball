import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseClubDetail } from "@/scrapers/ffhandball/club-details.scraper.js";

function fixture(name: string): string {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const COMPLET_URL = "https://monclub.ffhandball.fr/clubs/handball-club-de-vihiers/";
const MINIMAL_URL = "https://monclub.ffhandball.fr/clubs/3mt/";
const SANS_SALLE_URL = "https://monclub.ffhandball.fr/clubs/beach-handball-indre/";

describe("parseClubDetail — fixture complet (handball-club-de-vihiers)", () => {
  const html = fixture("ffhandball-club-detail-complet.html");
  const result = parseClubDetail(html, COMPLET_URL);

  it("extracts the club payload with all expected fields", () => {
    expect(result).not.toBeNull();
    expect(result!.club.id_ffhb).toBe("10514");
    expect(result!.club.nom).toBe("HANDBALL CLUB DE VIHIERS");
    expect(result!.club.slug).toBe("handball-club-de-vihiers");
    expect(result!.club.ville).toBe("VIHIERS");
    expect(result!.club.departement_code).toBe("49");
    expect(result!.club.email).toBe("6249073@ffhandball.net");
    expect(result!.club.site_web).toBe("http://www.hbcvihiers.fr");
    expect(result!.club.source_url).toBe(COMPLET_URL);
    expect(result!.club.telephone).toBe("0698704077");
    expect(result!.club.latitude).toBeCloseTo(47.14515, 4);
    expect(result!.club.longitude).toBeCloseTo(-0.53535, 4);
    expect(result!.club.nb_licence_senior_h).toBe(25);
    expect(result!.club.nb_licence_senior_f).toBe(16);
    expect(result!.club.adresse_correspondance).toBe("10 place de charles de gaulle");
    expect(result!.club.logo_club).toBe("2017-08-17-c58fab3d-4669-4b35-a844-daa319f03e48.png");
  });

  it("extracts the salle payload from gyms_club[0]", () => {
    expect(result!.salle).not.toBeNull();
    expect(result!.salle!.nom).toBe("LES COURTILS");
    expect(result!.salle!.ville).toBe("VIHIERS");
    expect(result!.salle!.code_postal).toBe("49310");
    expect(result!.salle!.departement_code).toBe("49");
    expect(result!.salle!.source_club_id_ffhb).toBe("10514");
    expect(result!.salle!.source_url).toBe(COMPLET_URL);
    // adresse trimmed of leading space
    expect(result!.salle!.adresse).toBe("RUE DES COURTILS");
    expect(result!.salle!.latitude).toBeCloseTo(47.14531, 4);
    expect(result!.salle!.longitude).toBeCloseTo(-0.52932, 4);
    // id_ffhb is the slug fallback
    expect(result!.salle!.id_ffhb).toMatch(/^[a-z0-9-]+$/);
  });

  it("links the club to its salle via salle_principale_id_ffhb", () => {
    expect(result!.club.salle_principale_id_ffhb).toBe(result!.salle!.id_ffhb);
  });
});

describe("parseClubDetail — fixture minimal (3mt)", () => {
  const html = fixture("ffhandball-club-detail-minimal.html");
  const result = parseClubDetail(html, MINIMAL_URL);

  it("returns the club with optional fields undefined when source omits them", () => {
    expect(result).not.toBeNull();
    expect(result!.club.id_ffhb).toBe("12121");
    expect(result!.club.nom).toBe("3MT");
    expect(result!.club.slug).toBe("3mt");
    expect(result!.club.ville).toBe("METZ");
    expect(result!.club.departement_code).toBe("57");
    expect(result!.club.site_web).toBeUndefined(); // url_club is undefined → filtered
  });

  it("still extracts a salle (this fixture has 1 gym)", () => {
    expect(result!.salle).not.toBeNull();
    expect(result!.salle!.nom).toBe("GYMNASE MALRAUX");
    expect(result!.salle!.code_postal).toBe("57000");
    expect(result!.salle!.departement_code).toBe("57");
  });
});

describe("parseClubDetail — fixture sans-salle (beach-handball-indre)", () => {
  const html = fixture("ffhandball-club-detail-sans-salle.html");
  const result = parseClubDetail(html, SANS_SALLE_URL);

  it("returns club but salle is null when gyms_club is false", () => {
    expect(result).not.toBeNull();
    expect(result!.club.id_ffhb).toBe("12230");
    expect(result!.club.nom).toBe("BEACH HANDBALL INDRE");
    expect(result!.club.departement_code).toBe("36");
    expect(result!.salle).toBeNull();
    expect(result!.club.salle_principale_id_ffhb).toBeUndefined();
  });

  it("concatenates address_club and address_club_2 when both are non-empty and distinct from title", () => {
    expect(result!.club.adresse_correspondance).toBe(
      "89 allee des platanes maison departementale des sports",
    );
  });
});

describe("parseClubDetail — HTML invalide", () => {
  it("returns null when no smartfire-component present", () => {
    expect(parseClubDetail("<html><body>empty</body></html>", COMPLET_URL)).toBeNull();
  });

  it("returns null when smartfire-component has malformed JSON", () => {
    const broken = `<smartfire-component name='single-club---home-hero-club' attributes='{not json'></smartfire-component>`;
    expect(parseClubDetail(broken, COMPLET_URL)).toBeNull();
  });

  it("returns null when JSON has no post or no acf", () => {
    const noAcf = `<smartfire-component name='single-club---home-hero-club' attributes='{"post":{"post_title":"X"}}'></smartfire-component>`;
    expect(parseClubDetail(noAcf, COMPLET_URL)).toBeNull();
  });
});
