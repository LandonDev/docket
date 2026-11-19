# Fixtures

- `two-speakers.ogg`: 35 seconds (412 s to 447 s) of the AMI Meeting Corpus
  meeting EN2002a, Mix-Headset, where two people speak in turn; mono Opus at
  24 kbit/s. AMI Meeting Corpus, CC BY 4.0,
  https://groups.inf.ed.ac.uk/ami/corpus/. Cut with the toolchain's ffmpeg
  9.0.2: `ffmpeg -ss 412 -t 35 -i en2002a.wav -ac 1 -c:a libopus -b:a 24k -map_metadata -1 two-speakers.ogg`.
