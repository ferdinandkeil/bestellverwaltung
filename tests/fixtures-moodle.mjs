// Synthetischer Moodle-Export im Format der Datenbank-Aktivität „Bauteilbestellung“ (Stand 11/2026).
// Keine echten Daten: Bestellnummern sind öffentlich übliche Typen, Gruppen und Kommentare erfunden.
export const MOODLE_CSV = [
  'Lieferant,Anzahl,Bestellnummer,Kommentar,Gruppe,Tags',
  'Mouser,3,511-NUCLEO-G031K8,,Thema 5,',
  'Reichelt,10,"X7R-G0603 100N","<p><a href=""https://www.reichelt.de/de/de/shop/produkt/x"">100nF Kondensator</a>, 0603</p>",Thema 5,#kondi',
  'Mouser,1,595-TMAG5273A2QDBVR,"<p>Hall-Sensor &amp; Ersatz,<br>falls einer kaputt geht</p>",Thema 6,"#mo, #mofo"',
  'TME,2,INA226AIDGSR,<p>Strom/Leistung</p>,Thema 6,',
  'Reichelt,3,DEBO JT ESP32-C,"<p>Thema 7 angelegt von Dozent</p>","Getrennte Gruppen                                        Alle Teilnehmer/innen                    Dozenten              ",',
  'Mouser,zwei,700-MAX3485EPA+,,Thema 7,',
  ',,,,,',
  'mouser,4,511-nucleo-g031k8,,Thema 5,',
  'Reichelt,1,MKDS 1-5 3-5.08,,,',
].join('\r\n') + '\r\n';
