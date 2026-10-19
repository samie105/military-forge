#!/bin/bash
# Where this box is, for the probe page's label (cloud-init.sh): prints "id|name|provider", e.g.
# "jnb|Johannesburg|Azure southafricanorth". Reads the cloud's metadata service (AWS, Azure, GCE);
# prints "box|this box|" anywhere else.
md() { curl -fsS -m 3 "$@" 2>/dev/null; }
z='' p=''
if t=$(md -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token) &&
  z=$(md -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/placement/availability-zone); then
  p=AWS
elif z=$(md -H Metadata:true 'http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text'); then
  p=Azure
elif z=$(md -H 'Metadata-Flavor: Google' http://169.254.169.254/computeMetadata/v1/instance/zone); then
  p=GCE z=${z##*/}
fi
z=$(printf %s "$z" | tr -dc 'a-z0-9-' | cut -c1-40)
case $z in
  *-los-*) id=los name=Lagos ;;
  southafricanorth | africa-south1*) id=jnb name=Johannesburg ;;
  southafricawest | af-south-1*) id=cpt name='Cape Town' ;;
  uksouth | eu-west-2*) id=lon name=London ;;
  '') id=box name='this box' ;;
  *) id=$(printf %s "$z" | cut -c1-16) name=$z ;;
esac
printf '%s|%s|%s\n' "$id" "$name" "${p:+$p $z}"
